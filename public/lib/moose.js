// Moose Score — PER-style individual performance rating, anchored so that
// Collin's career average = 10. Works the same for a single game or a career
// average: pass in whichever stat line you want scored.
//
// stats = { avgElims, avgDamageDealt, avgEliminated, avgDamageTaken, avgTimeAliveSeconds }

function computeRawMoose(stats, mooseCfg) {
  const { normalization: n, weights: w } = mooseCfg;
  const elimsTerm = w.elims * (10 * stats.avgElims / n.maxAvgElims);
  const damageTerm = w.damageDealt * (10 * stats.avgDamageDealt / n.maxAvgDamageDealt);
  const eliminatedTerm = w.eliminated * (10 * n.minAvgEliminated / stats.avgEliminated);
  const damageTakenTerm = w.damageTaken * (10 * n.minAvgDamageTaken / stats.avgDamageTaken);
  const timeTerm = w.timeAlive * (10 * stats.avgTimeAliveSeconds / n.maxAvgTimeAliveSeconds);
  return elimsTerm + damageTerm + eliminatedTerm + damageTakenTerm + timeTerm;
}

function computeMooseScore(stats, mooseCfg) {
  const raw = computeRawMoose(stats, mooseCfg);
  const { slope, intercept, shift } = mooseCfg.regression;
  return slope * raw + intercept + shift;
}

export { computeRawMoose, computeMooseScore };
