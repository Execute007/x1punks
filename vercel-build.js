const fs = require('fs');
const path = require('path');

// Copy generated punk images into public/generated/ so Vercel serves them as static assets
const srcDir = path.join(__dirname, 'generated');
const destDir = path.join(__dirname, 'public', 'generated');

if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.png'));
console.log(`Copying ${files.length} punk images to public/generated/...`);

for (const file of files) {
  fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
}

console.log(`Done. ${files.length} images copied.`);
