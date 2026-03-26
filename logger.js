const fs = require("fs");
const path = require("path");

function ensureLogDirectory(logFilePath) {
  const fullLogPath = path.resolve(logFilePath);
  const logDirectory = path.dirname(fullLogPath);

  if (!fs.existsSync(logDirectory)) {
    fs.mkdirSync(logDirectory, { recursive: true });
  }

  return fullLogPath;
}

function logMatch(match, logFilePath) {
  const resolvedLogPath = ensureLogDirectory(logFilePath);
  fs.appendFileSync(resolvedLogPath, `${JSON.stringify(match)}\n`, "utf8");

  const rulesLabel = Array.isArray(match.matchedRules) ? match.matchedRules.join(", ") : "unknown";
  console.log(
    `[MATCH] ${match.timestamp} | Group: ${match.groupName} | From: ${match.sender} | Rule: ${rulesLabel}`
  );
  console.log(`Message: "${match.messageBody}"`);
}

module.exports = {
  logMatch,
};