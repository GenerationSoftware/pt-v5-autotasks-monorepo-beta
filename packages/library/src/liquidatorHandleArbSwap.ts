import { Relayer } from "defender-relay-client";
import { ethers, Contract, BigNumber } from "ethers";
import { PopulatedTransaction } from "@ethersproject/contracts";
import { JsonRpcProvider } from "@ethersproject/providers";
import { DefenderRelayProvider, DefenderRelaySigner } from "defender-relay-client/lib/ethers";
import chalk from "chalk";
import ora from "ora";

import { ContractsBlob, ProviderOptions } from "./types";
import { logStringValue, logBigNumber, getContract, getContracts } from "./utils";
import { ERC20Abi } from "./abis/ERC20Abi";

const MARKET_RATE_CONTRACT_DECIMALS = 8;
const MIN_PROFIT_THRESHOLD_USD = 5; // Only swap if we're going to make at least $5.00

type Token = {
  name: string;
  decimals: string;
  address: string;
  symbol: string;
};

type Context = {
  tokenIn: Token;
  tokenOut: Token;
  tokenOutUnderlyingAsset: Token;
};

type SwapExactAmountInParams = {
  liquidationPairAddress: string;
  swapRecipient: string;
  exactAmountIn: BigNumber;
  amountOutMin: BigNumber;
};

export async function liquidatorHandleArbSwap(
  contracts: ContractsBlob,
  config: ProviderOptions,
  relayer: Relayer,
  swapRecipient: string,
  relayerAddress: string
  // ): Promise<PopulatedTransaction | undefined> {
) {
  const { provider } = config;

  // #1. Get contracts
  //
  const { liquidationPairs, liquidationRouter, marketRate, vaults } = getLiquidationContracts(
    contracts,
    config
  );

  // Loop through all liquidation pairs
  for (let i = 0; i < liquidationPairs.length; i++) {
    const liquidationPair = liquidationPairs[i];

    printAsterisks();
    console.log("LiquidationPair #", i + 1);
    printSpacer();

    const spinner = ora("Getting pair context...").start();
    const context: Context = await getContext(liquidationPair, contracts, provider);
    spinner.stop();

    printContext(context);
    printAsterisks();

    // #2. Calculate amounts
    //
    console.log(chalk.blue.bold(`1. Amounts:`));

    const { exactAmountIn, amountOutMin, tokenInAssetRateUsd, tokenOutAssetRateUsd } =
      await calculateAmounts(liquidationPair, marketRate, vaults, context);

    // #3. Test tx to get estimated return of tokenOut
    //
    const swapExactAmountInParams = {
      liquidationPairAddress: liquidationPair.address,
      swapRecipient,
      exactAmountIn,
      amountOutMin,
    };
    const amountOutEstimate = await liquidationRouter.callStatic.swapExactAmountIn(
      ...Object.values(swapExactAmountInParams)
    );
    logBigNumber(
      `Estimated amount of tokenOut to receive:`,
      amountOutEstimate,
      context.tokenOut.decimals,
      context.tokenOut.symbol
    );

    // #4. Decide if profitable or not
    //
    const profitable = await calculateProfit(
      contracts,
      marketRate,
      liquidationRouter,
      swapExactAmountInParams,
      provider,
      context,
      tokenOutAssetRateUsd,
      tokenInAssetRateUsd
    );
    if (!profitable) {
      console.log(
        chalk.red(
          `Liquidation Pair ${context.tokenIn.symbol}/${context.tokenOut.symbol}: currently not a profitable trade.`
        )
      );
      continue;
    }

    // #5. Print balance of tokenIn for relayer
    //
    const { sufficientBalance, balanceResult } = await checkBalance(
      context,
      liquidationPair,
      provider,
      relayerAddress,
      exactAmountIn
    );

    if (sufficientBalance) {
      console.log(chalk.green("Sufficient balance ✔"));
    } else {
      console.log(chalk.red("Insufficient balance ✔"));

      const diff = exactAmountIn.sub(balanceResult);
      console.log(chalk.grey(`Increase balance by: ${diff}`));

      continue;
    }

    // #6. Get allowance approval
    //
    await approve(exactAmountIn, liquidationPair, liquidationRouter, provider, relayerAddress);

    // #7. Finally, populate tx when profitable
    let transactionPopulated: PopulatedTransaction | undefined;
    console.log("LiquidationPair: Populating swap transaction ...");

    transactionPopulated = await liquidationRouter.populateTransaction.swapExactAmountIn(
      ...Object.values(swapExactAmountInParams)
    );

    try {
      // const transactionPopulated = await liquidatorHandleArbSwap(
      //   contracts,
      //   {
      //     chainId,
      //     provider: signer,
      //   },
      //   relayerAddress,
      //   swapRecipient
      // );

      // if (transactionPopulated) {
      let transactionSentToNetwork = await relayer.sendTransaction({
        data: transactionPopulated.data,
        to: transactionPopulated.to,
        gasLimit: 800000,
      });
      console.log(chalk.greenBright.bold("Transaction sent! ✔"));
      console.log(chalk.green("Transaction hash:", transactionSentToNetwork.hash));
      // } else {
      // console.log(chalk.red("LiquidationPair: Transaction not populated"));
      // }
    } catch (error) {
      throw new Error(error);
    }
  }

  // return transactionPopulated;
}

// Allowance
//
// Give permission to the LiquidationRouter to spend our Relayer/SwapRecipient's `tokenIn` (likely POOL)
// We will set allowance to max as we trust the security of the LiquidationRouter contract
// TODO: Only set allowance if there isn't one already set ...
const approve = async (
  exactAmountIn: BigNumber,
  liquidationPair: Contract,
  liquidationRouter: Contract,
  provider: DefenderRelayProvider | DefenderRelaySigner | JsonRpcProvider,
  relayerAddress: string
) => {
  try {
    printSpacer();
    console.log("Checking 'tokenIn' ERC20 allowance...");

    const tokenInAddress = await liquidationPair.tokenIn();
    const token = new ethers.Contract(tokenInAddress, ERC20Abi, provider);

    let allowanceResult = await token.functions.allowance(
      relayerAddress,
      liquidationRouter.address
    );
    allowanceResult = allowanceResult[0];
    logStringValue("Existing allowance:", allowanceResult.toString());

    if (allowanceResult.lt(exactAmountIn)) {
      const tx = await token.approve(liquidationRouter.address, ethers.constants.MaxInt256);
      await tx.wait();

      allowanceResult = await token.functions.allowance(relayerAddress, liquidationRouter.address);
      logStringValue("New allowance:", allowanceResult[0].toString());
    } else {
      console.log(chalk.green("Sufficient allowance ✔"));
    }
  } catch (error) {
    console.log(chalk.red("error: ", error));
  } finally {
    printAsterisks();
  }
};

const getLiquidationContracts = (
  contracts: ContractsBlob,
  config: ProviderOptions
): {
  liquidationPairs: Contract[];
  liquidationRouter: Contract;
  marketRate: Contract;
  vaults: Contract[];
} => {
  const { chainId, provider } = config;

  const contractsVersion = {
    major: 1,
    minor: 0,
    patch: 0,
  };

  const liquidationPairs = getContracts(
    "LiquidationPair",
    chainId,
    provider,
    contracts,
    contractsVersion
  );
  const liquidationRouter = getContract(
    "LiquidationRouter",
    chainId,
    provider,
    contracts,
    contractsVersion
  );
  const marketRate = getContract("MarketRate", chainId, provider, contracts, contractsVersion);
  const vaults = getContracts("Vault", chainId, provider, contracts, contractsVersion);

  return { liquidationPairs, liquidationRouter, marketRate, vaults };
};

// On testnet: Search testnet contract blob to get wETH contract then ask MarketRate contract
// TODO: Coingecko/other on production for rates
const getEthMarketRate = async (contracts: ContractsBlob, marketRate: Contract) => {
  const wethContract = contracts.contracts.find(
    (contract) =>
      contract.tokens &&
      contract.tokens.find((token) => token.extensions.underlyingAsset.symbol === "WETH")
  );

  const wethAddress = wethContract.tokens[0].extensions.underlyingAsset.address;
  const wethRate = await marketRate.priceFeed(wethAddress, "USD");

  return wethRate;
};

const getFeesUsd = async (
  estimatedGasLimit: BigNumber,
  ethMarketRateUsd: number,
  provider: DefenderRelayProvider | DefenderRelaySigner | JsonRpcProvider
): Promise<{ baseFeeUsd: number; maxFeeUsd: number; avgFeeUsd: number }> => {
  const baseFeeWei = (await provider.getFeeData()).lastBaseFeePerGas.mul(estimatedGasLimit);
  const maxFeeWei = (await provider.getFeeData()).maxFeePerGas.mul(estimatedGasLimit);

  const baseFeeUsd = parseFloat(ethers.utils.formatEther(baseFeeWei)) * ethMarketRateUsd;
  const maxFeeUsd = parseFloat(ethers.utils.formatEther(maxFeeWei)) * ethMarketRateUsd;

  const avgFeeUsd = (baseFeeUsd + maxFeeUsd) / 2;

  return { baseFeeUsd, maxFeeUsd, avgFeeUsd };
};

const testnetParseFloat = (amountBigNum: BigNumber): number => {
  return parseFloat(ethers.utils.formatUnits(amountBigNum, MARKET_RATE_CONTRACT_DECIMALS));
};

const getTokenInAssetRateUsd = async (
  liquidationPair: Contract,
  marketRate: Contract
): Promise<number> => {
  const tokenInAddress = await liquidationPair.tokenIn();
  const tokenInRate = await marketRate.priceFeed(tokenInAddress, "USD");

  return testnetParseFloat(tokenInRate);
};

const getTokenOutAssetRateUsd = async (
  liquidationPair: Contract,
  vaults: Contract[],
  marketRate: Contract
): Promise<number> => {
  // yield token/vault
  const tokenOutAddress = await liquidationPair.tokenOut();

  // underlying stablecoin we actually want
  const vaultContract = vaults.find((contract) => contract.address === tokenOutAddress);
  const tokenOutAsset = await vaultContract.functions.asset();
  const tokenOutAssetAddress = tokenOutAsset[0];
  const tokenOutAssetRate = await marketRate.priceFeed(tokenOutAssetAddress, "USD");

  return testnetParseFloat(tokenOutAssetRate);
};

// Gather information about this specific liquidation pair
// This is complicated because tokenIn is the token to supply (likely the prize token, which is probably POOL),
// while tokenOut is the Vault/Yield token, not the underlying asset which is likely the desired token (ie. DAI, USDC)
//
const getContext = async (
  liquidationPair: Contract,
  contracts: ContractsBlob,
  provider: DefenderRelayProvider | DefenderRelaySigner | JsonRpcProvider
): Promise<Context> => {
  // 1. IN TOKEN
  const tokenInAddress = await liquidationPair.tokenIn();
  const tokenInContract = new ethers.Contract(tokenInAddress, ERC20Abi, provider);

  const tokenIn = {
    address: tokenInAddress,
    decimals: await tokenInContract.decimals(),
    name: await tokenInContract.name(),
    symbol: await tokenInContract.symbol(),
  };

  // 2. VAULT TOKEN
  const tokenOutAddress = await liquidationPair.tokenOut();
  const tokenOutContract = new ethers.Contract(tokenOutAddress, ERC20Abi, provider);
  const tokenOut = {
    address: tokenOutAddress,
    decimals: await tokenOutContract.decimals(),
    name: await tokenOutContract.name(),
    symbol: await tokenOutContract.symbol(),
  };

  // 3. VAULT UNDERLYING ASSET TOKEN
  const vaultContract = contracts.contracts.find(
    (contract) => contract.type === "Vault" && contract.address === tokenOutAddress
  );
  const vaultUnderlyingAsset = vaultContract.tokens[0].extensions.underlyingAsset;

  const tokenOutUnderlyingAssetContract = new ethers.Contract(
    vaultUnderlyingAsset.address,
    ERC20Abi,
    provider
  );

  const tokenOutUnderlyingAsset = {
    address: vaultUnderlyingAsset.address,
    decimals: await tokenOutUnderlyingAssetContract.decimals(),
    name: vaultUnderlyingAsset.name,
    symbol: vaultUnderlyingAsset.symbol,
  };

  return { tokenIn, tokenOut, tokenOutUnderlyingAsset };
};

const printContext = (context) => {
  printAsterisks();
  console.log(
    chalk.blue.bold(`Liquidation Pair: ${context.tokenIn.symbol}/${context.tokenOut.symbol}`)
  );
  printSpacer();

  console.table(context);
};

const checkBalance = async (
  context: Context,
  liquidationPair: Contract,
  provider: DefenderRelayProvider | DefenderRelaySigner | JsonRpcProvider,
  relayerAddress: string,
  exactAmountIn: BigNumber
): Promise<{ sufficientBalance: boolean; balanceResult: BigNumber }> => {
  printAsterisks();
  console.log(chalk.blue.bold("3. Balance & Allowance"));
  console.log("Checking 'tokenIn' relayer balance ...");

  const tokenInAddress = await liquidationPair.tokenIn();
  const tokenContract = new ethers.Contract(tokenInAddress, ERC20Abi, provider);

  let balanceResult = await tokenContract.functions.balanceOf(relayerAddress);
  balanceResult = balanceResult[0];
  logBigNumber(
    `Relayer ${context.tokenIn.symbol} balance:`,
    balanceResult,
    context.tokenIn.decimals,
    context.tokenIn.symbol
  );

  const sufficientBalance = balanceResult.gt(exactAmountIn);

  return { sufficientBalance, balanceResult };
};

const printAsterisks = () => {
  printSpacer();
  console.log(chalk.blue("******************"));
};

const printSpacer = () => console.log("");

const calculateProfit = async (
  contracts: ContractsBlob,
  marketRate: Contract,
  liquidationRouter: Contract,
  swapExactAmountInParams: SwapExactAmountInParams,
  provider: DefenderRelayProvider | DefenderRelaySigner | JsonRpcProvider,
  context: Context,
  tokenOutAssetRateUsd: number,
  tokenInAssetRateUsd: number
): Promise<Boolean> => {
  const { amountOutMin, exactAmountIn } = swapExactAmountInParams;
  const ethMarketRate = await getEthMarketRate(contracts, marketRate);
  const ethMarketRateUsd = parseFloat(
    ethers.utils.formatUnits(ethMarketRate, MARKET_RATE_CONTRACT_DECIMALS)
  );

  const estimatedGasLimit = await liquidationRouter.estimateGas.swapExactAmountIn(
    ...Object.values(swapExactAmountInParams)
  );
  const { baseFeeUsd, maxFeeUsd, avgFeeUsd } = await getFeesUsd(
    estimatedGasLimit,
    ethMarketRateUsd,
    provider
  );

  printAsterisks();
  console.log(chalk.blue("4. Current gas costs for transaction:"));
  console.table({ baseFeeUsd, maxFeeUsd, avgFeeUsd });

  printAsterisks();
  console.log(chalk.blue.bold("5. Profit/Loss (USD):"));
  printSpacer();

  const tokenOutUsd =
    parseFloat(ethers.utils.formatUnits(amountOutMin, context.tokenOut.decimals)) *
    tokenOutAssetRateUsd;
  const tokenInUsd =
    parseFloat(ethers.utils.formatUnits(exactAmountIn, context.tokenIn.decimals)) *
    tokenInAssetRateUsd;

  const grossProfitUsd = tokenOutUsd - tokenInUsd;
  const netProfitUsd = grossProfitUsd - maxFeeUsd;

  console.log(chalk.magenta("Gross profit = tokenOut - tokenIn"));
  console.log(chalk.greenBright(grossProfitUsd, " = ", tokenOutUsd, " - ", tokenInUsd));
  printSpacer();

  console.log(chalk.magenta("Net profit = Gross profit - Gas fee (Max)"));
  console.log(chalk.greenBright(netProfitUsd, " = ", grossProfitUsd, " - ", maxFeeUsd));
  printSpacer();

  const profitable = netProfitUsd > MIN_PROFIT_THRESHOLD_USD;
  console.table({
    MIN_PROFIT_THRESHOLD_USD: `$${MIN_PROFIT_THRESHOLD_USD}`,
    "Net profit (USD)": `$${Math.round((netProfitUsd + Number.EPSILON) * 100) / 100}`,
    "Profitable?": profitable ? "✔" : "✗",
  });
  printSpacer();

  return profitable;
};

const calculateAmounts = async (
  liquidationPair: Contract,
  marketRate: Contract,
  vaults: Contract[],
  context: Context
): Promise<{
  exactAmountIn: BigNumber;
  amountOutMin: BigNumber;
  tokenInAssetRateUsd: number;
  tokenOutAssetRateUsd: number;
}> => {
  const maxAmountOut = await liquidationPair.callStatic.maxAmountOut();
  logBigNumber(
    `Max amount out available:`,
    maxAmountOut,
    context.tokenOut.decimals,
    context.tokenOut.symbol
  );

  // TODO: Play with fraction (or remove it) ...
  // ... likely needs to be based on how much the bot owner has of tokenIn
  // as well as how big of a trade they're willing to do
  const divisor = 2;
  logStringValue("Divide max amount out by:", Math.round(divisor));

  const wantedAmountOut = maxAmountOut.div(divisor);
  logBigNumber(
    "Wanted amount out:",
    wantedAmountOut,
    context.tokenOut.decimals,
    context.tokenOut.symbol
  );
  printSpacer();

  const exactAmountIn = await liquidationPair.callStatic.computeExactAmountIn(wantedAmountOut);
  logBigNumber("Exact amount in:", exactAmountIn, context.tokenIn.decimals, context.tokenIn.symbol);

  const amountOutMin = await liquidationPair.callStatic.computeExactAmountOut(exactAmountIn);
  logBigNumber(
    "Amount out minimum:",
    amountOutMin,
    context.tokenOut.decimals,
    context.tokenOut.symbol
  );

  printAsterisks();
  console.log(chalk.blue.bold(`2. Market rates:`));

  // prize token/pool
  const tokenInAssetRateUsd = await getTokenInAssetRateUsd(liquidationPair, marketRate);

  // yield token/vault
  // TODO: This will need to take into account the underlying asset instead and calculate
  // how much of that you can get for the amountOutMin of these shares
  const tokenOutAssetRateUsd = await getTokenOutAssetRateUsd(liquidationPair, vaults, marketRate);

  console.table({
    tokenIn: { symbol: context.tokenIn.symbol, "MarketRate USD": `$${tokenInAssetRateUsd}` },
    tokenOut: { symbol: context.tokenOut.symbol, "MarketRate USD": `$${tokenOutAssetRateUsd}` },
  });

  return {
    exactAmountIn,
    amountOutMin,
    tokenInAssetRateUsd,
    tokenOutAssetRateUsd,
  };
};
