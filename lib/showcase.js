import fs from 'fs';
import path from 'path';

// Skill showcases (docs/SHOWCASE.md): showcase/<skill>/showcase.json plus the images it names.
// They sit outside inventory/skills, so sync never installs them and the lock never hashes them.

export const SHOWCASE_DIR = 'showcase';
export const SHOWCASE_FILE = 'showcase.json';
export const MAX_IMAGE_BYTES = 512 * 1024;
export const MAX_SHOWCASE_BYTES = 64 * 1024;

export const SHOWCASE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME = SHOWCASE_NAME;
const IMAGE_FILE = /^[a-z0-9][a-z0-9-]{0,63}\.(png|jpg|webp)$/;
const HEX = /^#[0-9A-Fa-f]{6}$/;
// Printable text only: no control, bidi-override or invisible format characters, so a caption cannot
// be visually reordered. (Escaping is the Site's job; this keeps the text honest.)
const TEXT = /^[^\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]+$/;
const EXCERPT = /^[^\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]+$/; // newlines allowed
// Image signatures: PNG, JPEG, WebP (RIFF....WEBP).
const SIGNATURES = {
  png: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a,
  jpg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'
};
// Lengths fit the Site's layout: SVG text does not wrap (stage box 184 units, swatch column 80).
export const LIMITS = { stageName: 18, stageLine: 26, swatchName: 10 };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function onlyKeys(object, allowed, where, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) errors.push(`${where} has unknown key "${key}"`);
  }
}

// The Site is in English: showcase text carries no CJK characters (SKILL.md files may keep inline terms).
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\u3000-\u303F\uFF00-\uFFEF]/u;

function text(value, where, errors, max, pattern = TEXT) {
  if (typeof value !== 'string' || value.trim() === '' || !pattern.test(value)) {
    errors.push(`${where} must be non-empty printable text`);
  } else if (CJK.test(value)) {
    errors.push(`${where} must be in English (the Site shows no CJK text)`);
  } else if (value.length > max) {
    errors.push(`${where} is longer than ${max} characters`);
  }
}

function list(value, where, errors, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    errors.push(`${where} must be a list of ${min} to ${max} items`);
    return [];
  }
  return value;
}

/**
 * Checks one parsed showcase.json. Returns the image files it references.
 * @param {any} data
 * @param {string} where label for messages, e.g. "showcase/ui-design-tokens"
 * @param {string[]} errors
 * @returns {string[]}
 */
export function checkShowcaseData(data, where, errors) {
  const images = [];
  if (!isObject(data)) {
    errors.push(`${where}/${SHOWCASE_FILE} must be a JSON object`);
    return images;
  }
  onlyKeys(data, ['value', 'howItWorks', 'workflow', 'inAction'], `${where}/${SHOWCASE_FILE}`, errors);
  text(data.value, `${where} value`, errors, 400);

  if (!isObject(data.howItWorks)) {
    errors.push(`${where} howItWorks must be an object`);
  } else {
    onlyKeys(data.howItWorks, ['title', 'stages'], `${where} howItWorks`, errors);
    text(data.howItWorks.title, `${where} howItWorks.title`, errors, 120);
    const stages = list(data.howItWorks.stages, `${where} howItWorks.stages`, errors, 2, 4);
    if (stages.filter((stage) => stage?.accent === true).length > 1) errors.push(`${where} howItWorks has more than one accent stage`);
    stages.forEach((stage, i) => {
      const at = `${where} howItWorks.stages[${i}]`;
      if (!isObject(stage)) return errors.push(`${at} must be an object`);
      onlyKeys(stage, ['name', 'lines', 'accent'], at, errors);
      text(stage.name, `${at}.name`, errors, LIMITS.stageName);
      list(stage.lines, `${at}.lines`, errors, 1, 4).forEach((line, j) => text(line, `${at}.lines[${j}]`, errors, LIMITS.stageLine));
      if (stage.accent !== undefined && typeof stage.accent !== 'boolean') errors.push(`${at}.accent must be true or false`);
    });
  }

  list(data.workflow, `${where} workflow`, errors, 2, 6).forEach((step, i) => text(step, `${where} workflow[${i}]`, errors, 200));

  list(data.inAction, `${where} inAction`, errors, 1, 6).forEach((item, i) => {
    const at = `${where} inAction[${i}]`;
    if (!isObject(item)) return errors.push(`${at} must be an object`);
    onlyKeys(item, ['caption', 'source', 'image', 'excerpt', 'swatches'], at, errors);
    text(item.caption, `${at}.caption`, errors, 300);
    text(item.source, `${at}.source`, errors, 200);
    const kinds = ['image', 'excerpt', 'swatches'].filter((kind) => item[kind] !== undefined);
    if (kinds.length !== 1) return errors.push(`${at} needs exactly one of image, excerpt or swatches`);
    if (item.image !== undefined) {
      if (!isObject(item.image)) return errors.push(`${at}.image must be an object`);
      onlyKeys(item.image, ['file', 'alt'], `${at}.image`, errors);
      if (typeof item.image.file !== 'string' || !IMAGE_FILE.test(item.image.file)) {
        errors.push(`${at}.image.file must be a lowercase .png, .jpg or .webp file name in the same folder`);
      } else {
        images.push(item.image.file);
      }
      text(item.image.alt, `${at}.image.alt`, errors, 200);
    }
    if (item.excerpt !== undefined) text(item.excerpt, `${at}.excerpt`, errors, 1500, EXCERPT);
    if (item.swatches !== undefined) {
      list(item.swatches, `${at}.swatches`, errors, 1, 16).forEach((swatch, j) => {
        const sat = `${at}.swatches[${j}]`;
        if (!isObject(swatch)) return errors.push(`${sat} must be an object`);
        onlyKeys(swatch, ['name', 'hex'], sat, errors);
        text(swatch.name, `${sat}.name`, errors, LIMITS.swatchName);
        if (typeof swatch.hex !== 'string' || !HEX.test(swatch.hex)) errors.push(`${sat}.hex must be #RRGGBB`);
      });
    }
  });
  return images;
}

/**
 * Validates every showcase folder under repoRoot/showcase against the registry's skill names.
 * @param {string} repoRoot
 * @param {Set<string>} skillNames installable registry skill names
 * @returns {string[]} errors
 */
export function validateShowcases(repoRoot, skillNames) {
  const errors = [];
  const root = path.join(repoRoot, SHOWCASE_DIR);
  if (!fs.existsSync(root)) return errors;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const where = `${SHOWCASE_DIR}/${entry.name}`;
    if (!entry.isDirectory()) { // a symlinked folder is not a directory entry, so it lands here too
      errors.push(`${where} is not a folder; showcase/ holds one folder per skill`);
      continue;
    }
    if (!NAME.test(entry.name) || !skillNames.has(entry.name)) {
      errors.push(`${where} does not match an installable registry skill`);
      continue;
    }
    const folder = path.join(root, entry.name);
    const file = path.join(folder, SHOWCASE_FILE);
    const fileStat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!fileStat?.isFile()) {
      errors.push(`${where} has no ${SHOWCASE_FILE} (a regular file, not a link)`);
      continue;
    }
    if (fileStat.size > MAX_SHOWCASE_BYTES) {
      errors.push(`${where}/${SHOWCASE_FILE} is larger than ${MAX_SHOWCASE_BYTES / 1024} KB`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      errors.push(`${where}/${SHOWCASE_FILE} is not valid JSON (${error.message})`);
      continue;
    }
    const images = new Set(checkShowcaseData(data, where, errors));
    for (const image of images) {
      const imagePath = path.join(folder, image);
      const stat = fs.lstatSync(imagePath, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) errors.push(`${where}/${image} is referenced but is not a file`);
      else if (stat.size > MAX_IMAGE_BYTES) errors.push(`${where}/${image} is larger than ${MAX_IMAGE_BYTES / 1024} KB`);
      else if (!SIGNATURES[path.extname(image).slice(1)](fs.readFileSync(imagePath))) errors.push(`${where}/${image} is not a ${path.extname(image).slice(1)} image`);
    }
    for (const name of fs.readdirSync(folder)) {
      if (name !== SHOWCASE_FILE && !images.has(name)) errors.push(`${where}/${name} is not referenced by ${SHOWCASE_FILE}`);
    }
  }
  return errors;
}
