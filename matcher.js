function matchRules(messageBody, rules) {
  if (typeof messageBody !== "string" || !Array.isArray(rules)) {
    return [];
  }

  // Normalize common Unicode dash variants from mobile keyboards/copy-paste.
  const normalizedBody = messageBody.replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-");

  const matchedRules = [];

  for (const rule of rules) {
    if (!rule || typeof rule.name !== "string" || typeof rule.pattern !== "string") {
      continue;
    }

    const flags = typeof rule.flags === "string" ? rule.flags : "";

    try {
      const regex = new RegExp(rule.pattern, flags);
      if (regex.test(messageBody) || regex.test(normalizedBody)) {
        matchedRules.push(rule.name);
      }
    } catch (error) {
      console.error(`[RULE_ERROR] Skipping invalid rule '${rule.name}': ${error.message}`);
    }
  }

  return matchedRules;
}

module.exports = {
  matchRules,
};