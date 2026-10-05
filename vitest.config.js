// Tests live at ./tests/ (outside `files/`), so vitest needs the repo root
// rather than the `files/` root used by the production build.
import {defineConfig, configDefaults} from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    // The project lives on an exFAT volume, where macOS scatters `._*` AppleDouble
    // sidecar files next to every file. They match the include glob but aren't
    // valid JS, so rollup fails to parse them and vitest reports phantom failures.
    // Ignore them (keeping vitest's own defaults).
    exclude: [...configDefaults.exclude, '**/._*'],
  },
});
