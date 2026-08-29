const PROFILE_ID_LOCAL_B = 'hlg-local-b-v1';
const PROFILE_ID_GENERIC = 'hlg-rec709-v1';
const PROFILE_ID_PQ = 'pq-rec709-v1';
// Backwards alias – existing code imports PROFILE_ID (local B)
const PROFILE_ID = PROFILE_ID_LOCAL_B;

const FILTER_GRAPH_LOCAL_B = 'libplacebo=tonemapping=spline:tonemapping_param=0.45:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le,eq=gamma=0.90';
const FILTER_GRAPH_GENERIC = 'libplacebo=tonemapping=bt.2390:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le';
const FILTER_GRAPH_PQ = 'libplacebo=tonemapping=bt.2390:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le';
const FILTER_GRAPH = FILTER_GRAPH_LOCAL_B;

const PROFILES = {
  [PROFILE_ID_LOCAL_B]: FILTER_GRAPH_LOCAL_B,
  [PROFILE_ID_GENERIC]: FILTER_GRAPH_GENERIC,
  [PROFILE_ID_PQ]: FILTER_GRAPH_PQ,
};

const ALLOWED_PROFILE_IDS = new Set([PROFILE_ID_LOCAL_B, PROFILE_ID_GENERIC, PROFILE_ID_PQ]);

function isKnownProfileId(id) {
  return ALLOWED_PROFILE_IDS.has(id);
}

function getFilterGraph(profileId) {
  return PROFILES[profileId] || null;
}

function getProfileIds() {
  return Array.from(ALLOWED_PROFILE_IDS);
}

module.exports = {
  PROFILE_ID,
  FILTER_GRAPH,
  PROFILE_ID_LOCAL_B,
  PROFILE_ID_GENERIC,
  PROFILE_ID_PQ,
  PROFILE_ID_LOCAL_B_V1: PROFILE_ID_LOCAL_B,
  PROFILE_ID_REC709_V1: PROFILE_ID_GENERIC,
  PROFILE_ID_PQ_V1: PROFILE_ID_PQ,
  FILTER_GRAPH_LOCAL_B,
  FILTER_GRAPH_GENERIC,
  FILTER_GRAPH_PQ,
  FILTER_GRAPH_REC709: FILTER_GRAPH_GENERIC,
  PROFILES,
  ALLOWED_PROFILE_IDS,
  isKnownProfileId,
  getFilterGraph,
  getProfileIds,
};
