// Runs during the build (called from link-persist.js, inside musicapp/, after Task Automator has been copied in).
// Gives the Music Finder download its own animated screen: the real website keeps working underneath, out of sight,
// and you see the 7 steps tick off one by one. Only the Music Finder download uses it (project "music-finder-run");
// the Task Automator screens you open yourself stay exactly as they were.
const fs = require('fs');

const dst = 'android/app/src/main/java/com/taskautomator';
const file = dst + '/BrowserActivity.java';
if (!fs.existsSync(file)) {
  console.log('BrowserActivity was not found, skipping the download animation.');
  return;
}
fs.copyFileSync('../native-finder/RunOverlay.java', dst + '/RunOverlay.java');

let s = fs.readFileSync(file, 'utf8');
if (s.indexOf('runOverlay') >= 0) {
  console.log('The download animation is already linked.');
  return;
}

let missing = [];
function add(label, test, replace) {
  if (typeof test === 'string') {
    if (s.indexOf(test) < 0) {
      missing.push(label);
      return;
    }
    s = s.replace(test, () => replace(test));
  } else {
    const m = s.match(test);
    if (!m) {
      missing.push(label);
      return;
    }
    s = s.replace(test, (x) => replace(x));
  }
}

add('field', 'private int failedSteps = 0;', (x) => x + '\n    private RunOverlay runOverlay;');
add(
  'create',
  'bridge = new RecorderBridge(webView);',
  (x) =>
    x +
    '\n        if (!recordMode && "music-finder-run".equals(getIntent().getStringExtra("projectId"))) {' +
    '\n            runOverlay = RunOverlay.attach(this, project.steps.length(), () -> secondaryBtn.performClick());' +
    '\n        }'
);
add('start', /statusText\.setText\("Starting[^"]*"\);/, (x) => x + '\n        if (runOverlay != null) runOverlay.onStart();');
add('step', 'statusText.setText("Running step " + shown + " of " + total);', (x) => x + '\n        if (runOverlay != null) runOverlay.onStep(shown, total);');
add(
  'done',
  '            secondaryBtn.setText("Close");\n            return;\n        }\n\n        // wait while a page is still loading',
  (x) => '            if (runOverlay != null) runOverlay.onAllSteps(failedSteps);\n' + x
);
add('stop', '        statusText.setText(msg);\n        secondaryBtn.setText("Close");', (x) => '        statusText.setText(msg);\n        if (runOverlay != null) runOverlay.onStopped(msg);\n        secondaryBtn.setText("Close");');
add('destroy', '    protected void onDestroy() {\n        handler.removeCallbacksAndMessages(null);', (x) => x + '\n        if (runOverlay != null) runOverlay.shutdown();');

if (missing.length > 0) {
  // never break the build for this: leave the plain screen as it was
  console.log('The download animation could not be linked (' + missing.join(', ') + '). Keeping the plain screen.');
  fs.unlinkSync(dst + '/RunOverlay.java');
  return;
}
fs.writeFileSync(file, s);
console.log('Download animation linked into the Task Automator run screen');
