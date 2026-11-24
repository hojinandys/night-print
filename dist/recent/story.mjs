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
    : `${name(stats.entity)}에서 값이 낮아진 면적은 ${number(stats.lowerArea)}%입니다.`;
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
    ? `${name(steadilyRising.entity)}은 기록된 ${years.length}개 연도에서 평균이 매년 올랐습니다. 그런데 마지막 해의 밝기가 처음보다 낮은 면적도 ${number(steadilyRising.lowerArea)}%입니다. `
    : '';
  const differences = stats.map((item) => `${name(item.entity)} ${number(item.change, 2, true)}`).join(', ');
  return {
    title: '평균 그래프에 나타나지 않는 변화',
    body: `${evidence}평균 차이는 ${differences} ${units}입니다. 이제 표면에서 같은 색이 모인 곳과 금빛·푸른빛이 섞인 곳을 찾아보세요.`,
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
    ? `${firstLabel}에서 ${lastLabel}까지, ${stats.map((item) => `${name(item.entity)}의 ${percentageOrDifference(item, units)}`).join(', ')}입니다. 이 변화가 지역 전체에서 고르게 일어났을까요?`
    : `${firstLabel} ${number(overall.from, 2)}에서 ${lastLabel} ${number(overall.to, 2)} ${units}로, ${percentageOrDifference(overall, units)}입니다. ${regionName} 안의 모든 구역이 비슷하게 변했을까요?`;
  const regionalThird = {
    title: '지도에서 아는 곳 찾아보기',
    body: `${regionName}의 평균 차이는 ${number(overall.change, 2, true)} ${units}입니다. 지도에서 궁금한 구역을 고르면 해당 경계와 수치를 함께 볼 수 있습니다. 익숙한 곳은 이 표면에서 어떤 모양으로 나타나나요?`,
  };
  const chapters = [
    { title: directions, body: firstBody },
    {
      title: monthly ? '같은 달의 밝기를 비교하면' : '밝아진 곳과 어두워진 곳',
      body: `${lastLabel} 값에서 같은 위치의 ${firstLabel} 값을 뺐습니다. 금빛은 증가, 푸른빛은 감소입니다. ${stats.map(areaDescription).join(' ')} 비율은 공통 관측 영역 기준입니다. 작은 음수도 포함하며 통계적 유의성을 뜻하지 않습니다.`,
    },
    all ? distributionChapter(stats, years, monthly, units) : regionalThird,
    {
      title: '내가 아는 곳은 어떻게 변했을까',
      body: `다시 전체를 보면, ${regionName}의 변화를 어떤 말로 설명할 수 있을까요? 빛이 늘거나 줄었다는 기록만으로 그곳의 삶이나 변화의 원인까지 알 수는 없습니다. 궁금한 지역을 골라 더 살펴보세요.${monthly ? ' 같은 달 비교에도 날씨와 관측 품질의 영향은 남습니다.' : ''}`,
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
