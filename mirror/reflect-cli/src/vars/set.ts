import {getFirestore} from 'firebase/firestore';
import {setVars} from 'mirror-protocol/src/vars.js';
import {ensureAppInstantiated} from '../app-config.js';
import {setDevVars} from '../dev/vars.js';
import {UserError} from '../error.js';
import type {AuthContext} from '../handler.js';
import {password} from '../inquirer.js';
import {makeRequester} from '../requester.js';
import {watchDeployment} from '../watch-deployment.js';
import type {YargvToInterface} from '../yarg-types.js';
import type {CommonVarsYargsArgv} from './types.js';

export function setVarsOptions(yargs: CommonVarsYargsArgv) {
  return yargs.positional('keysAndValues', {
    describe:
      'Space-separated KEY=VALUE pairs, or KEY only to input its VALUE with a password prompt',
    type: 'string',
    array: true,
    demandOption: true,
  });
}

type SetVarsHandlerArgs = YargvToInterface<ReturnType<typeof setVarsOptions>>;

export async function setVarsHandler(
  yargs: SetVarsHandlerArgs,
  authContext: AuthContext,
): Promise<void> {
  const {keysAndValues, dev} = yargs;

  const vars: Record<string, string> = {};
  for (const kv of keysAndValues) {
    const eq = kv.indexOf('=');
    if (eq === 0) {
      throw new UserError(`Malformed KEY=VALUE pair "${kv}"`);
    }
    const key = eq > 0 ? kv.substring(0, eq) : kv;
    if (Object.hasOwn(vars, key)) {
      throw new UserError(`Duplicate entries for KEY "${key}"`);
    }
    const value =
      eq > 0
        ? kv.substring(eq + 1)
        : await password({
            message: `Enter the value for ${key}:`,
          });
    vars[key] = value;
  }

  if (dev) {
    setDevVars(vars);
    console.log('Set dev variables');
    return;
  }

  const {userID} = authContext.user;
  const {appID} = await ensureAppInstantiated(authContext);
  const data = {requester: makeRequester(userID), appID, vars};
  const {deploymentPath} = await setVars.call(data);
  if (!deploymentPath) {
    console.log('Stored encrypted environment variables');
  } else {
    console.log('Deploying updated environment variables');
    await watchDeployment(getFirestore(), deploymentPath, 'Deployed');
  }
}