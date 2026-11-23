"""Build observed-data arrays inside an isolated edition directory."""
from pathlib import Path
import argparse,json,math,shutil,sys
import collect_data as collector
from boundaries import ROOT

def prepare(plan,cache,source_project=None):
    config=json.loads((ROOT/'pipeline/source_config.json').read_text(encoding='utf-8'))
    pin={int(x['year']):x['sha256'] for x in config['downloads']}
    pin.update({int(k):v for k,v in plan.get('accepted_sha256',{}).items()})
    years=plan['years'];source=ROOT/'data/source';meta=ROOT/'data/metadata'
    source.mkdir(parents=True,exist_ok=True);meta.mkdir(parents=True,exist_ok=True)
    cached_facts={}
    if source_project:
        source_project=Path(source_project).resolve()
        facts_path=source_project/'data/processed/facts.json'
        cached_facts={x['file']:x['sha256'] for x in json.loads(facts_path.read_text(encoding='utf-8'))['source_crops']}
        shutil.copy2(source_project/'data/source/korea_dongs_20231231.geojson',source/'korea_dongs_20231231.geojson')
    collector.ensure_boundaries(offline=bool(source_project))
    collector.write_json(meta/'edition.json',{'years':years,'baseline_year':2015,'historical_replay':plan.get('historical_replay',False)})
    receipts=[]
    for year in years:
        wanted=[f'data/source/{region}_{year}_source.tif' for region in ['seoul','busan','jeju']]
        if source_project and all((source_project/p).exists() for p in wanted):
            for rel in wanted:
                path=source_project/rel
                if rel not in cached_facts or collector.digest(path)!=cached_facts[rel]:
                    raise ValueError(f'Preserved source crop changed: {rel}')
                shutil.copy2(path,ROOT/rel)
            receipts.append({'year':year,'url':plan['files'][str(year)],'sha256':pin.get(year),'status':'verified_preserved_crops','crop_hashes':{rel:cached_facts[rel] for rel in wanted}})
        else:
            record=collector.collect_one(year,plan['files'][str(year)],cache,source,pin.get(year))
            expected_bounds=config['downloads'][0]['bounds']
            if not all(math.isclose(a,b,rel_tol=0,abs_tol=1e-8) for a,b in zip(record['raster']['bounds'],expected_bounds)):
                raise ValueError('Source georeferencing changed; manual product review is required.')
            receipts.append(record)
    collector.write_json(meta/'source_receipts.json',receipts)
    import analyze
    facts=analyze.build()
    if facts['years']!=years or len(facts['source_crops'])!=len(years)*3:
        raise ValueError('Incomplete edition; no publication allowed')
    return receipts

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--plan',type=Path,required=True);p.add_argument('--cache',type=Path,required=True);p.add_argument('--source-project',type=Path);a=p.parse_args()
    prepare(json.loads(a.plan.read_text(encoding='utf-8')),a.cache.resolve(),a.source_project)
