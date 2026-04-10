const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, 'employee_groups.csv');
const content = fs.readFileSync(csvPath, 'utf8');

// The naive way this was split in loadCsv was `content.split(/\n/)`, so any quoted newlines scrambled it.
// We can parse the entire file properly by writing a quick state-machine to flatten out the newlines inside quotes.

let cleanedContent = '';
let inQuotes = false;
for (let i = 0; i < content.length; i++) {
  const char = content[i];
  if (char === '"') {
    inQuotes = !inQuotes;
  }
  
  if ((char === '\n' || char === '\r') && inQuotes) {
    // Replace newlines inside quotes with a space
    cleanedContent += ' ';
  } else {
    cleanedContent += char;
  }
}

// Remove empty/garbage lines that might have spawned as artifacts
const validLines = cleanedContent.split('\n')
  .map(line => line.trim())
  .filter(line => {
    // Keep header
    if (line.includes('Last check-in text')) return true;
    
    // We only want rows that actually match our schema
    const cells = line.split(',');
    // If it has fewer than 4 items, it's missing data, but let's keep it if it looks valid
    // Let's just strictly filter out rows that only have "- Coordinated with..." types of stubs
    if (!line.includes('"') && !line.includes(',')) return false;
    
    // Remove leaked text rows that start with literal quotes containing dashes
    if (line.startsWith('"- ') || line.startsWith('"Work Summary')) return false;
    
    return true;
  });

fs.writeFileSync(csvPath, validLines.join('\n'), 'utf8');
console.log('Successfully repaired employee_groups.csv');
