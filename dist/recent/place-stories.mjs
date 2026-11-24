import catalog from './place-story-data.mjs?v=130273a1e1e0';

export const PLACE_STORIES = catalog.cases;
export const PLACE_METHOD = catalog.method;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

export function eligiblePlaceStories(manifest) {
  if (!manifest || manifest.period?.kind === 'monthly_same_month' ||
      manifest.source?.doi !== '10.5258/SOTON/WP00772') return [];
  return PLACE_STORIES.filter((story) => {
    const descriptor = manifest.experience?.files?.find((f) => f.region === story.region);
    return JSON.stringify(manifest.years) === JSON.stringify(story.basis.years) &&
      manifest.units === story.observation.units &&
      descriptor?.sha256 === story.basis.interactionHash &&
      manifest.regions?.some((r) => r.id === story.region) &&
      observationSummary(story) !== null;
  });
}

export function observationSummary(story) {
  const from = story?.observation?.series?.find((s) => s.year === story.fromYear)?.mean;
  const to = story?.observation?.series?.find((s) => s.year === story.toYear)?.mean;
  if (!finite(from) || !finite(to) || from < 0 || to < 0) return null;
  const change = to - from;
  return { from, to, change, percent: from > 0 ? change / from * 100 : null };
}

export function placeStoryScene(story, manifest) {
  if (!eligiblePlaceStories(manifest).some((s) => s.id === story?.id)) return null;
  return { region: story.region, mode: 'absolute', compare: true,
    compareA: story.fromYear, compareB: story.toYear,
    yearIndex: manifest.years.indexOf(story.toYear), district: null };
}

export function projectPlace(story, interaction) {
  if (!story || !interaction || interaction.region !== story.region ||
      interaction.source?.series_sha256 !== story.observation.sourceHash ||
      JSON.stringify(interaction.years) !== JSON.stringify(story.basis.years)) return null;
  const c = interaction.coordinates;
  if (c?.source_crs !== 'EPSG:32652' || !c.utm_origin?.every(finite) ||
      !finite(c.utm_to_world_scale) || c.utm_to_world_scale <= 0) return null;
  const [ox, oy] = c.utm_origin, s = c.utm_to_world_scale;
  const [x, y] = story.location.utm, [x0, y0, x1, y1] = story.location.boundsUtm;
  return { point: [(x - ox) * s, (y - oy) * s],
    bounds: [(x0 - ox) * s, (y0 - oy) * s, (x1 - ox) * s, (y1 - oy) * s] };
}
