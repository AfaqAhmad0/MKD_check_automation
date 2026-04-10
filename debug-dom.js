/**
 * Quick diagnostic: connects to a running WhatsApp Web instance,
 * takes a screenshot, and dumps the message area HTML structure.
 * 
 * Run while the main app is running (it shares the same browser session).
 */

const puppeteer = require("puppeteer-core");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const path = require("path");
const fs = require("fs");

const SESSION_DIR = path.join(__dirname, ".wwebjs_auth");

(async () => {
  // Connect to the existing Chrome instance via the whatsapp-web.js session
  // We need to launch a NEW browser with the same user data dir
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false, // Show the browser so we can see what's going on
    userDataDir: path.join(SESSION_DIR, "session"),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const pages = await browser.pages();
  let page = pages[0];
  
  // Navigate to WhatsApp Web
  await page.goto("https://web.whatsapp.com", { waitUntil: "networkidle2", timeout: 60000 });
  console.log("Page loaded, waiting for WhatsApp to initialize...");
  
  await new Promise(r => setTimeout(r, 10000));

  // Take a screenshot
  await page.screenshot({ path: path.join(__dirname, "debug-screenshot.png"), fullPage: true });
  console.log("Screenshot saved to debug-screenshot.png");

  // Dump the DOM structure of the message area
  const domInfo = await page.evaluate(() => {
    // Find all elements with data-id (messages)
    const dataIdElements = document.querySelectorAll("[data-id]");
    
    // Find elements with common message classes
    const messageIn = document.querySelectorAll("div.message-in");
    const messageOut = document.querySelectorAll("div.message-out"); 
    const copyableText = document.querySelectorAll("span.copyable-text");
    const selectableText = document.querySelectorAll("span.selectable-text");
    
    // Find role=row elements (message containers in newer WA Web)
    const rows = document.querySelectorAll('[role="row"]');
    
    // Find all divs with any data-testid
    const testIds = new Set();
    document.querySelectorAll("[data-testid]").forEach(el => {
      testIds.add(el.getAttribute("data-testid"));
    });
    
    // Get the HTML of the first few message-like elements
    let sampleHTML = "";
    const allMsgLike = document.querySelectorAll('[data-id], div.message-in, div.message-out, [role="row"]');
    for (let i = 0; i < Math.min(3, allMsgLike.length); i++) {
      sampleHTML += `\n--- Element ${i} (tag=${allMsgLike[i].tagName}, class=${allMsgLike[i].className.slice(0,100)}) ---\n`;
      sampleHTML += allMsgLike[i].outerHTML.slice(0, 1000) + "\n";
    }

    return {
      dataIdCount: dataIdElements.length,
      messageInCount: messageIn.length,
      messageOutCount: messageOut.length,
      copyableTextCount: copyableText.length,
      selectableTextCount: selectableText.length,
      rowCount: rows.length,
      testIds: [...testIds].slice(0, 50),
      sampleHTML,
      bodyClasses: document.body.className,
      url: window.location.href,
    };
  });

  console.log("\n=== DOM DIAGNOSTIC ===");
  console.log("URL:", domInfo.url);
  console.log("Body classes:", domInfo.bodyClasses);
  console.log("Elements with [data-id]:", domInfo.dataIdCount);
  console.log("div.message-in:", domInfo.messageInCount);
  console.log("div.message-out:", domInfo.messageOutCount);
  console.log("span.copyable-text:", domInfo.copyableTextCount);
  console.log("span.selectable-text:", domInfo.selectableTextCount);
  console.log('[role="row"]:', domInfo.rowCount);
  console.log("data-testid values found:", domInfo.testIds.join(", "));
  console.log("\n=== SAMPLE HTML ===");
  console.log(domInfo.sampleHTML);

  await browser.close();
  process.exit(0);
})().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
