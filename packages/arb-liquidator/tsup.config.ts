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
        BUILD_COVALENT_API_KEY: `'${config.get(`${CHAIN_ID}.COVALENT_API_KEY`)}'`,
        BUILD_JSON_RPC_URI: `'${config.get(`${CHAIN_ID}.JSON_RPC_URI`)}'`,
        BUILD_SWAP_RECIPIENT: `'${config.get(`${CHAIN_ID}.SWAP_RECIPIENT`)}'`,
        BUILD_USE_FLASHBOTS: `'${config.get(`${CHAIN_ID}.USE_FLASHBOTS`)}'`,
        BUILD_MIN_PROFIT_THRESHOLD_USD: `'${config.get(`${CHAIN_ID}.MIN_PROFIT_THRESHOLD_USD`)}'`,
      };
    },
    noExternal: [
      'inquirer',
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
