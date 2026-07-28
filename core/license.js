// Monetization seam. Present from day one on purpose.
//
// tier() currently always returns 'pro'. If this ever ships as a paid product,
// ONLY this function changes — key validation, caching, offline grace period.
// Every limit is read through limits() and nowhere else, so there is no need
// to hunt through the codebase for places to insert a gate.

export const TIERS = {
  free: {
    maxRecordings: 100,
    models: ['base', 'small'],
    export: false,
  },
  pro: {
    maxRecordings: Infinity,
    models: ['base', 'small', 'medium', 'large-v3-turbo', 'large-v3'],
    export: true,
  },
};

export function tier() {
  return 'pro';
}

export function limits() {
  return TIERS[tier()];
}

export function assertModelAllowed(model) {
  if (!limits().models.includes(model)) {
    throw new Error(`Model ${model} is not available on the ${tier()} tier`);
  }
}
