// The two columns of the board: which client is the source of truth, which is the mirror.
//
// Every script reads them from here so nothing assumes a particular pair. Both come from
// the config's existing `source` and `mirror` blocks:
//
//   column  the output directory (`<out>/<column>/<capture>.png`), the key in a manifest
//           entry (`capture[column].route`), and the file suffix where both clients write
//           into one directory (`semantics/<capture>.<source column>.json`,
//           `api/<capture>.<mirror column>.json`).
//   name    what people and the reviewer read ("webapp", "iOS app", "desktop client").
//
// The defaults are the pair this harness was first built for — a web source and a Flutter
// mirror — so a config written before these fields existed behaves exactly as it did.
const DEFAULTS = {
  source: { column: 'web', name: 'webapp' },
  mirror: { column: 'mobile', name: 'Flutter mobile app' },
};

function side(block, fallback) {
  return {
    id: block?.column ?? fallback.column,
    label: block?.name ?? fallback.name,
  };
}

export function columns(cfg) {
  const source = side(cfg.source, DEFAULTS.source);
  const mirror = side(cfg.mirror, DEFAULTS.mirror);
  if (source.id === mirror.id) {
    throw new Error(
      `source and mirror both use the column "${source.id}" — their captures would overwrite each other. ` +
        `Set a distinct \`column\` on one of them.`,
    );
  }
  return { source, mirror };
}
