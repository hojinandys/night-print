// Each edition tells its own observations. The viewer chooses the place.
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const number = (value, digits = 1, signed = false) =>
  `${signed && value > 0 ? '+' : ''}${value.toFixed(digits)}`;
const name = (entity) => entity.label || entity.name || entity.full_name || String(entity.id);

function observation(entity, year, years) {
  const record = entity.series?.find((item) => Number(item.year) === year);
  const index = years.indexOf(year);
  const mean = finite(record?.mean) ? record.mean : entity.means?.[index];
  return finite(mean) && mean >= 0 ? { mean, record } : null;
}

function comparison(entity, first, last, years) {
  const a = observation(entity, first, years), b = observation(entity, last, years);
  if (!a || !b) return null;
  const change = b.mean - a.mean, rawArea = b.record?.decreased_area_pct;
  const lowerArea = first === years[0] && finite(rawArea) && rawArea >= 0 && rawArea <= 100 + 1e-6
    ? Math.min(100, rawArea) : null;
  return { entity, from: a.mean, to: b.mean, change,
    percent: a.mean > 0 ? change / a.mean * 100 : null, lowerArea };
}

function percentageOrDifference(stats, units) {
  return finite(stats.percent)
    ? `평균 변화는 ${number(stats.percent, 1, true)}%`
    : `평균 차이는 ${number(stats.change, 2, true)} ${units}`;
}

function areaDescription(stats) {
  return stats.lowerArea === null
    ? `${name(stats.entity)}의 감소 면적 통계는 제공되지 않습니다.`
    : `${name(stats.entity)}에서 값이 낮아진 면적은 공통 관측 영역의 ${number(stats.lowerArea)}%입니다.`;
}

function direction(stats) {
  return stats.change > 0 ? '높아졌습니다' : stats.change < 0 ? '낮아졌습니다' : '같습니다';
}

function distributionChapter(stats, years, monthly, units) {
  // Two monthly observations never establish a continuous annual trend.
  const steadilyRising = !monthly && years.length >= 3 && stats.find((item) => {
    const means = years.map((year) => observation(item.entity, year, years)?.mean);
    return item.lowerArea > 0 && means.every((mean, index) => finite(mean)
      && (index === 0 || mean > means[index - 1]));
  });
  const evidence = steadilyRising
    ? `${name(steadilyRising.entity)}은 이 판의 ${years.length}개 연도에서 평균이 매년 높아졌지만, 마지막 해에 처음보다 값이 낮은 면적도 ${number(steadilyRising.lowerArea)}% 남아 있습니다. `
    : '';
  const differences = stats.map((item) => `${name(item.entity)} ${number(item.change, 2, true)}`).join(', ');
  return {
    title: '같은 말로 묶이지 않는 밤의 지문',
    body: `${evidence}평균 변화량은 ${differences} ${units}입니다. 출발 밝기가 다르므로 변화율의 순위만으로 빛이 얼마나, 어디서 달라졌는지 알 수 없습니다. 이 작품의 ‘지문’은 빛의 배치와 변화가 남긴 서로 다른 모양입니다.`,
  };
}

/** Four chapters; overview stays in all regions, regional guides stay local. */
export function createGuide(manifest, regionId = 'all') {
  if (!manifest || !Array.isArray(manifest.years) || !manifest.years.length
      || !Array.isArray(manifest.regions) || !manifest.regions.length) {
    throw new Error('The guide requires a complete observation edition.');
  }
  const years = manifest.years.map(Number);
  if (years.some((year) => !Number.isInteger(year)) || new Set(years).size !== years.length) {
    throw new Error('The guide requires distinct observed years.');
  }
  const first = Number(manifest.baseline_year ?? years[0]), last = years.at(-1);
  if (!years.includes(first)) throw new Error('The guide baseline is not an observed year.');
  const all = regionId === 'all' || regionId == null;
  const requested = all ? manifest.regions : manifest.regions.filter((region) => String(region.id) === String(regionId));
  if (!requested.length) throw new Error('The selected guide region is not in this edition.');
  const stats = requested.map((region) => comparison(region, first, last, years));
  if (stats.some((item) => !item)) throw new Error('The selected region has incomplete observations.');
  const monthly = manifest.period?.kind === 'monthly_same_month';
  const period = (year) => monthly ? `${year}년 ${manifest.period.month}월` : `${year}년`;
  const firstLabel = period(first), lastLabel = period(last), units = manifest.units || 'nW/cm²/sr';
  const overall = stats[0], regionName = all ? '세 지역' : name(overall.entity);
  const directions = all
    ? stats.every((item) => item.change > 0) ? '세 지역의 평균은 모두 높아졌습니다'
      : stats.every((item) => item.change < 0) ? '세 지역의 평균은 모두 낮아졌습니다'
      : stats.every((item) => item.change === 0) ? '세 지역의 평균은 그대로입니다'
      : '세 지역의 평균은 서로 다른 방향입니다'
    : `${regionName}의 평균은 ${direction(overall)}`;
  const firstBody = all
    ? `${firstLabel}에서 ${lastLabel}까지, ${stats.map((item) => `${name(item.entity)}의 ${percentageOrDifference(item, units)}`).join(', ')}입니다. 한 방향이나 순위로 묶기 전에, 그 말 안에 어떤 장소들이 들어 있는지 봅니다.`
    : `${firstLabel} ${number(overall.from, 2)}에서 ${lastLabel} ${number(overall.to, 2)} ${units}로, ${percentageOrDifference(overall, units)}입니다. ${regionName} 전체를 한 방향으로 말할 때, 그 안의 어떤 자리가 보이지 않게 될까요?`;
  const regionalThird = {
    title: `${regionName} 안에서 스스로 고르는 자리`,
    body: `${regionName}의 평균 차이는 ${number(overall.change, 2, true)} ${units}입니다. 평균은 변화의 크기를 요약하지만 빛이 달라진 위치를 대신 보여 주지는 않습니다. 특정 구역을 정답으로 고르지 않고, 표면과 지도에서 궁금한 자리를 직접 선택해 보세요. 이 작품의 ‘지문’은 빛의 배치와 변화가 남긴 모양입니다.`,
  };
  const chapters = [
    { title: directions, body: firstBody },
    {
      title: monthly ? '같은 달, 같은 자리에서 빛을 빼면' : '같은 자리에서 처음의 빛을 빼면',
      body: `${lastLabel}의 실제 관측에서 같은 위치의 ${firstLabel} 값을 뺐습니다. 금빛은 증가, 푸른빛은 감소입니다. ${stats.map(areaDescription).join(' ')} 작은 음수도 포함하며 통계적 유의성을 뜻하지 않습니다.`,
    },
    all ? distributionChapter(stats, years, monthly, units) : regionalThird,
    {
      title: '밤이 달라졌다는 말 다음에',
      body: `서로 다르게 변한 자리를 본 뒤 다시 전체를 바라봅니다. 처음에 하나로 보였던 밤을 이제 어떤 말로 설명하고 싶은가요? 빛의 증감만으로 그곳의 삶이나 성장·쇠퇴를 단정하지 않습니다.${monthly ? ' 같은 달 비교에도 날씨와 관측 품질의 영향은 남습니다.' : ''}`,
    },
  ];
  return { region: all ? 'all' : requested[0].id, district: null, chapters };
}

/** A guide changes the view, never starts a comparison or selects a district. */
export function guideScene(guide, step, years) {
  const index = Math.max(0, Math.min(guide.chapters.length - 1, step));
  return { guide: index, region: guide.region, yearIndex: years.length - 1,
    mode: index === 0 ? 'absolute' : 'change', compare: false, district: null, zoom: false };
}
