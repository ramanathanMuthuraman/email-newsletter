import gulp     from 'gulp';
import plugins  from 'gulp-load-plugins';
import browser  from 'browser-sync';
import rimraf   from 'rimraf';
import panini   from 'panini';
import yargs    from 'yargs';
import lazypipe from 'lazypipe';
import inky     from 'inky';
import fs       from 'fs';
import siphon   from 'siphon-media-query';
import path     from 'path';
import merge    from 'merge-stream';
import beep     from 'beepbeep';
import colors   from 'colors';

const $ = plugins();


const nestedChildPattern = '**/*';
const htmlExtension = '.html';
const scssExtension = '.scss';
const cssExtension = '.css';
const src = 'src';
const assets = 'assets';
const archive = 'archive';
const dist = 'dist';
const img = 'img';
const css = 'css';
const root = yargs.argv.root;
const scss = path.join('scss', root);
const rootPages = path.join(src, 'pages', root);
const layouts = path.join(src, 'layouts');
const partials = path.join(src, 'partials');
const helpers = path.join(src, 'helpers');
const sourceAssets = path.join(src, assets);

// Look for the --production flag
const PRODUCTION = !!(yargs.argv.production);
const EMAIL = yargs.argv.to;

// Declar var so that both AWS and Litmus task can use it.
var CONFIG;

// Build the "dist" folder by running all of the below tasks
gulp.task('build',
  gulp.series(clean, pages, sass, images, inline));

// Build emails, run the server, and watch for file changes
gulp.task('default',
  gulp.series('build', server, watch));

// Build emails, then send to litmus
gulp.task('litmus',
  gulp.series('build', creds, aws, litmus));

// Build emails, then send to EMAIL
gulp.task('mail',
  gulp.series('build', creds, aws, mail));

// Build emails, then zip
gulp.task('zip',
  gulp.series('build', zip));

// Delete the "dist" folder
// This happens every time a build starts
function clean(done) {
  rimraf(dist, done);
}

// Compile layouts, pages, and partials into flat HTML files
// Then parse using Inky templates
function pages() {
  return gulp.src([path.join(rootPages, nestedChildPattern + htmlExtension), '!' + path.join('archive/' + nestedChildPattern + htmlExtension)])
    .pipe(panini({
      root: rootPages,
      layouts,
      partials,
      helpers
    }))
    .pipe(inky())
    .pipe(gulp.dest(dist));
}

// Reset Panini's cache of layouts and partials
function resetPages(done) {
  panini.refresh();
  done();
}

// Compile Sass into CSS
function sass() {
  return gulp.src(path.join(sourceAssets, scss, 'app' + scssExtension))
    .pipe($.if(!PRODUCTION, $.sourcemaps.init()))
    .pipe($.sass({
      includePaths: ['node_modules/foundation-emails/scss']
    }).on('error', $.sass.logError))
    .pipe($.if(PRODUCTION, $.uncss(
      {
        html: [path.join(dist + nestedChildPattern + htmlExtension)]
      })))
    .pipe($.if(!PRODUCTION, $.sourcemaps.write()))
    .pipe(gulp.dest(path.join(dist, css)));
}

// Copy and compress images
function images() {
  return gulp.src([path.join(sourceAssets, img, nestedChildPattern), '!' + path.join(sourceAssets, img, archive, nestedChildPattern)])
    .pipe($.imagemin())
    .pipe(gulp.dest('.' + path.join(dist, assets, img)));
}

// Inline CSS and minify HTML
function inline() {
  return gulp.src(path.join(dist, nestedChildPattern + htmlExtension))
    .pipe($.if(PRODUCTION, inliner(path.join(dist, css, 'app' + cssExtension))))
    .pipe(gulp.dest(dist));
}

// Start a server with LiveReload to preview the site in
function server(done) {
  browser.init({
    server: dist
  });
  done();
}

// Watch for file changes
function watch() {
  gulp.watch(path.join(rootPages, nestedChildPattern + htmlExtension)).on('all', gulp.series(pages, inline, browser.reload));
  gulp.watch([path.join(layouts, nestedChildPattern), path.join(partials, nestedChildPattern)]).on('all', gulp.series(resetPages, pages, inline, browser.reload));
  gulp.watch(['../' + path.join(scss, nestedChildPattern + scssExtension), path.join(sourceAssets, scss, nestedChildPattern + scssExtension)]).on('all', gulp.series(resetPages, sass, pages, inline, browser.reload));
  gulp.watch(path.join(sourceAssets, img, nestedChildPattern)).on('all', gulp.series(images, browser.reload));
}

// Inlines CSS into HTML, adds media query CSS into the <style> tag of the email, and compresses the HTML
function inliner(css) {
  var css = fs.readFileSync(css).toString();
  var mqCss = siphon(css);

  var pipe = lazypipe()
    .pipe($.inlineCss, {
      applyStyleTags: false,
      removeStyleTags: true,
      preserveMediaQueries: true,
      removeLinkTags: false
    })
    .pipe($.replace, '<!-- <style> -->', `<style>${mqCss}</style>`)
    .pipe($.replace, '<link rel="stylesheet" type="text/css" href="../css/app.css">', '')
    .pipe($.htmlmin, {
      collapseWhitespace: true,
      minifyCSS: true
    });

  return pipe();
}

// Ensure creds for Litmus are at least there.
function creds(done) {
  var configPath = './config.json';
  try {
    CONFIG = JSON.parse(fs.readFileSync(configPath));
  }
  catch (e) {
    beep();
    console.log('[AWS]'.bold.red + ' Sorry, there was an issue locating your config.json. Please see README.md');
    process.exit();
  }
  done();
}

// Post images to AWS S3 so they are accessible to Litmus and manual test
function aws() {
  var publisher = !!CONFIG.aws ? $.awspublish.create(CONFIG.aws) : $.awspublish.create();
  var headers = {
    'Cache-Control': 'max-age=315360000, no-transform, public'
  };

  return gulp.src(path.join(dist, 'assets/img/*'))
  // publisher will add Content-Length, Content-Type and headers specified above
  // If not specified it will set x-amz-acl to public-read by default
    .pipe(publisher.publish(headers))

    // create a cache file to speed up consecutive uploads
    //.pipe(publisher.cache())

    // print upload updates to console
    .pipe($.awspublish.reporter());
}

// Send email to Litmus for testing. If no AWS creds then do not replace img urls.
function litmus() {
  var awsURL = !!CONFIG && !!CONFIG.aws && !!CONFIG.aws.url ? CONFIG.aws.url : false;

  return gulp.src(path.join(dist, nestedChildPattern + htmlExtension))
    .pipe($.if(!!awsURL, $.replace(/=('|")(\/?assets\/img)/g, "=$1" + awsURL)))
    .pipe($.litmus(CONFIG.litmus))
    .pipe(gulp.dest(dist));
}

// Send email to specified email for testing. If no AWS creds then do not replace img urls.
function mail() {
  var awsURL = !!CONFIG && !!CONFIG.aws && !!CONFIG.aws.url ? CONFIG.aws.url : false;

  if (EMAIL) {
    CONFIG.mail.to = [EMAIL];
  }

  return gulp.src(path.join(dist, nestedChildPattern + htmlExtension))
    .pipe($.if(!!awsURL, $.replace(/=('|")(\/?assets\/img)/g, "=$1" + awsURL)))
    .pipe($.mail(CONFIG.mail))
    .pipe(gulp.dest(dist));
}

// Copy and compress into Zip
function zip() {
  var dist = dist;
  var ext = '.html';

  function getHtmlFiles(dir) {
    return fs.readdirSync(dir)
      .filter(function (file) {
        var fileExt = path.join(dir, file);
        var isHtml = path.extname(fileExt) == ext;
        return fs.statSync(fileExt).isFile() && isHtml;
      });
  }

  var htmlFiles = getHtmlFiles(dist);

  var moveTasks = htmlFiles.map(function (file) {
    var sourcePath = path.join(dist, file);
    var fileName = path.basename(sourcePath, ext);

    var moveHTML = gulp.src(sourcePath)
      .pipe($.rename(function (path) {
        path.dirname = fileName;
        return path;
      }));

    var moveImages = gulp.src(sourcePath)
      .pipe($.htmlSrc({selector: 'img'}))
      .pipe($.rename(function (path) {
        path.dirname = fileName + path.dirname.replace(dist, '');
        return path;
      }));

    return merge(moveHTML, moveImages)
      .pipe($.zip(fileName + '.zip'))
      .pipe(gulp.dest(dist));
  });

  return merge(moveTasks);
}
