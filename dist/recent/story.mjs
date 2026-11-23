// Narrative selection uses the published observations only. It never invents
// a declining district when the selected region's district means all rise.
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const number = (value, digits = 1, signed = false) =>
  `${signed && value > 0 ? '+' : ''}${value.toFixed(digits)}`;
const name = (entity) => entity.label || entity.name || entity.full_name || String(entity.id);
const coverageEligible = (entity) => finite(entity.coverage_pct)
  && entity.coverage_pct >= 85 && entity.coverage_pct <= 100 + 1e-6;

function observation(entity, year, years) {
  const record = entity.series?.find((item) => Number(item.year) === year);
  const index = years.indexOf(year);
  const mean = finite(record?.mean) ? record.mean : entity.means?.[index];
  return finite(mean) && mean >= 0 ? { mean, record } : null;
}

function comparison(entity, first, last, years) {
  const a = observation(entity, first, years), b = observation(entity, last, years);
  if (!a || !b) return null;
  const change = b.mean - a.mean;
  const rawArea = b.record?.decreased_area_pct;
  const area = finite(rawArea) && rawArea >= 0 && rawArea <= 100 + 1e-6
    ? Math.min(100, rawArea) : null;
  return { entity, from: a.mean, to: b.mean, change,
    percent: a.mean > 0 ? change / a.mean * 100 : null,
    lowerArea: first === years[0] ? area : null };
}

function percentageOrDifference(stats, units) {
  return finite(stats.percent)
    ? `평균 변화는 ${number(stats.percent, 1, true)}%`
    : `평균 차이는 ${number(stats.change, 2, true)} ${units}`;
}

function magnitude(stats) {
  return finite(stats.percent) ? Math.abs(stats.percent) : Math.abs(stats.change);
}

function chooseDistrict(regionStats, districts) {
  const opposite = districts.filter((item) => regionStats.change * item.change < 0)
    .sort((a, b) => magnitude(b) - magnitude(a) || String(a.entity.id).localeCompare(String(b.entity.id)));
  if (opposite.length) return { chosen: opposite[0], counterexample: true };
  // Without an opposite district mean, look inside a district whose increase
  // is smaller, and favour a measured mix of positive and negative positions.
  const slower = regionStats.change > 0 && finite(regionStats.percent)
    ? districts.filter((item) => item.change >= 0 && finite(item.percent) && item.percent < regionStats.percent)
    : [];
  const candidates = [...(slower.length ? slower : districts)].sort((a, b) =>
    (b.lowerArea ?? -1) - (a.lowerArea ?? -1)
    || magnitude(a) - magnitude(b)
    || String(a.entity.id).localeCompare(String(b.entity.id)));
  return { chosen: candidates[0] || null, counterexample: false };
}

function placeChapter(region, overall, chosen, counterexample, allDistricts, units) {
  const regionName = name(region);
  if (!chosen) return {
    title: `${regionName}의 관측 범위를 먼저 봅니다`,
    body: '두 시점 값이 확인되고 공통 관측 범위가 85% 이상인 구역을 고르지 못했습니다. 지역 전체의 표면과 관측 범위를 먼저 살펴보세요. 공통 관측에서 제외된 자리를 어두운 곳이나 값 0으로 읽지 않습니다.',
  };
  const districtName = name(chosen.entity);
  if (counterexample) return {
    title: `${districtName}, 평균과 다른 방향`,
    body: `${regionName} 전체의 ${percentageOrDifference(overall, units)}이지만, ${districtName}의 ${percentageOrDifference(chosen, units)}입니다. 지도와 입체에 표시된 같은 경계를 따라가 보세요. 구역 전체의 평균과 그 안의 자리를 함께 읽습니다. 빛의 변화만으로 성장·쇠퇴나 원인을 단정하지 않습니다.`,
  };

  const allRise = allDistricts.length === (region.districts || []).length
    && allDistricts.length > 0 && allDistricts.every((item) => item.change > 0);
  const lowerSentence = chosen.lowerArea === null
    ? '이 구역의 감소 면적 통계는 없어 비율을 제시하지 않습니다.'
    : chosen.lowerArea > 0
      ? `그 안에서도 값이 낮아진 면적은 공통 관측 영역의 ${number(chosen.lowerArea)}%입니다. 작은 차이도 포함한 비율입니다.`
      : '이 구역의 공통 관측 영역에서 값이 낮아진 면적은 0.0%입니다.';

  if (region.id === 'jeju' && allRise && allDistricts.length === 2
      && allDistricts.every((item) => finite(item.percent))) {
    const cities = allDistricts.map((item) => `${name(item.entity)} ${number(item.percent, 1, true)}%`).join(', ');
    return {
      title: chosen.lowerArea > 0 ? '두 도시의 증가, 그 안의 다른 자리' : '두 도시가 밝아진 서로 다른 크기',
      body: `${cities}. 두 도시의 평균은 모두 높아졌습니다. 이번에는 ${districtName} 안으로 들어갑니다. ${lowerSentence} 도시 하나를 고른 뒤에도 평균과 모든 자리의 변화는 구분해서 읽습니다.`,
    };
  }

  if (allRise) return {
    title: chosen.lowerArea > 0 ? `${districtName}, 증가 속에 남은 감소` : `${districtName}, 같은 방향의 다른 크기`,
    body: `이 판에서 ${regionName}의 구·군·시 평균은 모두 높아졌습니다. ${districtName}의 ${percentageOrDifference(chosen, units)}입니다. ${lowerSentence} 구역의 평균이 높아졌다는 사실과 모든 자리가 밝아졌다는 말은 다릅니다.`,
  };

  return {
    title: chosen.change === 0 ? `${districtName}, 평균이 같을 때도` : `${districtName} 안의 변화를 펼칩니다`,
    body: `${regionName} 전체의 ${percentageOrDifference(overall, units)}, ${districtName}의 ${percentageOrDifference(chosen, units)}입니다. ${lowerSentence} 경계 안의 높낮이를 살피며, 한 숫자가 담은 변화의 크기와 분포를 함께 봅니다.`,
  };
}

/** Four chapters for the selected region and the edition's real baseline. */
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
  const requested = regionId === 'all' || regionId == null
    ? manifest.regions.find((region) => region.id === 'seoul') || manifest.regions[0]
    : manifest.regions.find((region) => String(region.id) === String(regionId));
  if (!requested) throw new Error('The selected guide region is not in this edition.');
  const overall = comparison(requested, first, last, years);
  if (!overall) throw new Error('The selected region has incomplete observations.');
  const allDistricts = (requested.districts || []).map((district) => comparison(district, first, last, years)).filter(Boolean);
  const { chosen, counterexample } = chooseDistrict(overall, allDistricts.filter((item) => coverageEligible(item.entity)));
  const monthly = manifest.period?.kind === 'monthly_same_month';
  const period = (year) => monthly ? `${year}년 ${manifest.period.month}월` : `${year}년`;
  const firstLabel = period(first), lastLabel = period(last), regionName = name(requested);
  const units = manifest.units || 'nW/cm²/sr';
  const direction = overall.change > 0 ? '높아졌습니다' : overall.change < 0 ? '낮아졌습니다' : '같습니다';
  const question = {
    seoul: '여러 구역을 한 숫자로 묶은 서울의 밤입니다. 각 구역의 변화도 같은 방향일까요?',
    busan: '구·군마다 다른 높낮이가 부산의 한 표면을 이룹니다. 전체와 각 구역의 방향을 차례로 살펴봅니다.',
    jeju: '두 도시를 하나의 평균으로 묶은 제주의 밤입니다. 그 안의 작은 자리들도 함께 움직였을까요?',
  }[requested.id] || '한 숫자에 담긴 여러 장소의 방향을 차례로 살펴봅니다.';
  const areaSentence = overall.lowerArea === null
    ? '이 비교의 감소 면적 통계는 제공되지 않습니다. 표면과 관측 범위를 함께 확인하세요.'
    : `값이 낮아진 면적은 공통 관측 영역의 ${number(overall.lowerArea)}%입니다. 작은 음수도 포함하며 통계적 유의성을 뜻하지 않습니다.`;
  const chapters = [
    {
      title: `${regionName}의 평균은 ${direction}`,
      body: `${firstLabel} ${number(overall.from, 2)}에서 ${lastLabel} ${number(overall.to, 2)} ${units}로, ${percentageOrDifference(overall, units)}입니다. ${question}`,
    },
    {
      title: monthly ? '같은 달의 빛을 빼면' : '같은 자리에서 처음의 값을 빼면',
      body: `${lastLabel}의 표면에서 같은 위치의 ${firstLabel} 값을 뺐습니다. 금빛은 증가, 푸른빛은 감소입니다. ${areaSentence}`,
    },
    placeChapter(requested, overall, chosen, counterexample, allDistricts, units),
    {
      title: `${regionName}의 두 밤을 같은 시선에서`,
      body: `A는 ${firstLabel}, B는 ${lastLabel}의 실제 관측입니다. 두 작품은 같은 각도로 함께 움직이며, 작은 화면에서는 위아래로 놓입니다. ${monthly ? '같은 달을 비교해도 날씨와 관측 품질의 영향은 남습니다. ' : ''}‘비교 끄기’를 누르면 한 작품으로 돌아갑니다. 다른 구역이나 시점을 골라 질문을 이어가세요.`,
    },
  ];
  return { region: requested.id, district: chosen?.entity.id ?? null, counterexample, chapters };
}
