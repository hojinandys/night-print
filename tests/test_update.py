import copy,json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'pipeline'))
import update

def metadata(last=2023):
    return {'data':[{'id':'62620','iso3':'KOR','doi':update.CONFIG['doi'],'files':[update.CONFIG['file_prefix']+f'kor_viirs_nvf_{year}_100m_v1.tif' for year in range(2015,last+1)]}]}

def fake_site(path,years=(2015,2016),tag='old'):
    path.mkdir(parents=True);(path/'index.html').write_text(tag,encoding='utf-8');(path/'data').mkdir();(path/'art').mkdir()
    Image.new('RGB',(640,360),'#17232b').save(path/'art/frame.webp','WEBP',quality=80)
    regions=[]
    for name in ['seoul','busan','jeju']:
        frames=[{'year':y,'url':'art/frame.webp'} for y in years]
        regions.append({'id':name,'coverage_pct':90,'means':[1]*len(years),'render':{'absolute':frames,'change':frames}})
    update.write_json(path/'data/manifest.json',{'years':list(years),'regions':regions})

class UpdateTests(unittest.TestCase):
    def test_unchanged_metadata_does_not_require_rendering(self):
        p=update.make_plan(metadata(),list(range(2015,2024)))
        self.assertFalse(p['needs_build']);self.assertEqual(p['new_years'],[])

    def test_new_contiguous_observation_requests_one_new_year(self):
        p=update.make_plan(metadata(2024),list(range(2015,2024)))
        self.assertTrue(p['needs_build']);self.assertEqual(p['new_years'],[2024]);self.assertEqual(p['years'][0],2015)

    def test_gap_or_changed_product_is_review_needed(self):
        m=metadata(2024);m['data'][0]['files'].pop(3)
        with self.assertRaises(update.ReviewNeeded):update.make_plan(m,list(range(2015,2024)))
        m=metadata();m['data'][0]['id']='new-product'
        with self.assertRaises(update.ReviewNeeded):update.official_files(m)
        m=metadata();m['data'][0]['doi']='another-product'
        with self.assertRaises(update.ReviewNeeded):update.official_files(m)

    def test_changed_source_host_is_rejected(self):
        m=metadata();m['data'][0]['files'][0]=m['data'][0]['files'][0].replace('data.worldpop.org','example.org')
        with self.assertRaises(update.ReviewNeeded):update.official_files(m)

    def test_replay_only_accepts_existing_observed_years(self):
        p=update.make_plan(metadata(),list(range(2015,2024)),replay=2022)
        self.assertEqual(p['years'][-1],2022);self.assertTrue(p['historical_replay'])
        with self.assertRaises(update.ReviewNeeded):update.make_plan(metadata(),[],replay=2024)

    def test_incomplete_art_never_replaces_published_site(self):
        with tempfile.TemporaryDirectory() as d:
            d=Path(d);old=d/'dist';new=d/'stage';fake_site(old);fake_site(new,tag='new')
            (new/'art/frame.webp').unlink()
            with self.assertRaises(ValueError):update.promote(new,old,d/'history')
            self.assertEqual((old/'index.html').read_text(),'old')

    def test_failed_swap_rolls_back_existing_site(self):
        with tempfile.TemporaryDirectory() as d:
            d=Path(d);old=d/'dist';new=d/'stage';fake_site(old);fake_site(new,tag='new')
            rename=Path.rename
            def fail_new(self,target):
                if self==new:raise OSError('simulated failed move')
                return rename(self,target)
            with patch.object(Path,'rename',fail_new):
                with self.assertRaises(OSError):update.promote(new,old,d/'history')
            self.assertEqual((old/'index.html').read_text(),'old')

    def test_success_preserves_previous_edition_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            d=Path(d);old=d/'dist';new=d/'stage';fake_site(old);fake_site(new,range(2015,2024),'new')
            result=update.promote(new,old,d/'history')
            self.assertEqual((old/'index.html').read_text(),'new');self.assertEqual((Path(result['previous_edition'])/'index.html').read_text(),'old')
            self.assertFalse(update.make_plan(metadata(),update.read_json(old/'data/manifest.json')['years'])['needs_build'])

    def test_concurrent_update_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'update.lock'
            with update.update_lock(p):
                with self.assertRaises(RuntimeError):
                    with update.update_lock(p):pass
            self.assertFalse(p.exists())

    def test_non_finite_values_block_publishing(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'dist';fake_site(p);m=update.read_json(p/'data/manifest.json');m['regions'][0]['means'][0]=float('nan');update.write_json(p/'data/manifest.json',m)
            with self.assertRaises(ValueError):update.validate_site(p)

if __name__=='__main__':unittest.main()
