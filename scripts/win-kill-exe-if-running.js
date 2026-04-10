/**
 * pkg must replace dist/checkin-tracking.exe; Windows returns EPERM if the exe is still running.
 * Best-effort: stop our process by image name before pkg runs.
 */
const { execSync } = require("child_process");

if (process.platform !== "win32") {
  process.exit(0);
}

try {
  execSync("taskkill /IM checkin-tracking.exe /F", { stdio: "ignore" });
  console.log("[build] Stopped running checkin-tracking.exe so pkg can overwrite it.");
} catch {
  // Not running, or could not terminate — pkg may still succeed.
}
