// esbuild --alias target for Ink's dev-only `react-devtools-core` import.
//
// Ink pulls react-devtools-core in through devtools.js behind a
// `process.env.DEV === 'true'` gate. With a single --outfile, esbuild inlines
// that dynamically-imported module and hoists its top-level import to an eager
// static import, so `--external` crashes at boot with ERR_MODULE_NOT_FOUND
// (RESEARCH Pitfall 1). Aliasing the package to this empty stub removes the
// unresolvable dependency while leaving the harmless, DEV-gated
// `import.meta.resolve("react-devtools-core")` inside Ink's try/catch.
//
// Self-contained, Node-stdlib-only convention (mirrors scripts/csm-*.mjs).
export default {};
