import { defineConfig } from 'tsup';

import Configstore from 'configstore';
import pkg from './package.json';

const config = new Configstore(pkg.name);

export default defineConfig((opt) => {
  return {
    esbuildOptions: (options, context) => {
      const CHAIN_ID = config.get('CHAIN_ID');
      if (!CHAIN_ID || !(`${CHAIN_ID}` in config.all))
        throw new Error(
          'Missing chain configuration! Try running `yarn start` first to set the config.',
        );
      options.define = {
        ...(options.define ?? {}),
        BUILD_CHAIN_ID: `'${CHAIN_ID}'`,
      };
    },
    noExternal: [
      '@generationsoftware/pt-v5-autotasks-library',
      '@generationsoftware/pt-v5-utils-js-beta',
      'ethers-multicall-provider',
      'configstore',
    ],
    format: 'cjs',
    entry: ['src/handler.ts'],
    splitting: false,
    clean: true,
    minify: true,
  };
});
