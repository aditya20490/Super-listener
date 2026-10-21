// Runs during the build: packs the tag editor page (html + css + crop tool) into one JS file the app can show.
const fs = require('fs');
const dir = 'old-tags/www/';
let html = fs.readFileSync(dir + 'index.html', 'utf8');
const css = fs.readFileSync(dir + 'app.css', 'utf8');
const crop = fs.readFileSync(dir + 'crop.js', 'utf8');
const hi = html.indexOf('</head>');
html = html.slice(0, hi) + '<style>' + css + '</style>' + html.slice(hi);
const bi = html.lastIndexOf('</body>');
html = html.slice(0, bi) + '<script>' + crop + '</script>' + html.slice(bi);
fs.mkdirSync('src/tools', { recursive: true });
fs.writeFileSync('src/tools/tagEditorHtml.js', 'export default ' + JSON.stringify(html) + ';\n');
console.log('Tag editor page packed:', html.length, 'characters');
