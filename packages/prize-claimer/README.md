# @pooltogether/v5-autotasks-prize-claimer

OpenZeppelin Defender autotask to auto-claim prizes on behalf of PoolTogether hyperstructure (v5) depositors.

## Development

### Env

We use [direnv](https://direnv.net) to manage environment variables. You'll likely need to install it.

Copy `.envrc.example` and write down the env variables needed to run this project.
```
cp .envrc.example .envrc
```

Once your env variables are setup, load them with:
```
direnv allow
```

### Autotasks

Depending on which autotask you wish to update, you need to set the following env variables:

```
export AUTOTASK_ID=
export CHAIN_ID=
export RELAYER_API_KEY=
export RELAYER_API_SECRET=
```

Here are the currently deployed autotasks and their corresponding ID.

#### Testnet
##### Sepolia

```
export AUTOTASK_ID=83...
export CHAIN_ID=11155111
```


### Run autotask

To run the autotask locally, run:

```
npm start
```

### Update autotask

To update the autotask, run:

```
npm run update
```