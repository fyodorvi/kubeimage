#! /usr/bin/env node

'use strict';

const exec = require('child_process').exec;
const chalk = require('chalk');
const timestamp = require('time-stamp');
const _ = require('lodash');

let namespace;
let kubeConfig;

function timeLog (line) {
    console.log(`[${chalk.grey(timestamp('HH:mm:ss'))}] ${line}`);
}

function parsePods (stdout) {
    let m;
    const re = /([^\s]+)[\s]+([\d]*)\/([\d]*)[\s]+([^\s]+)[\s]+([\d]*)/gm;
    const activePods = [];
    while (m = re.exec(stdout)) {
        const m2 = /^(.*)-[\d]*-/.exec(m[1]);
        activePods.push({
            id: m[1],
            ready: m[3] == m[2],
            name: m2 ? m2[1] : m[1],
            state: m[4],
            restarts: m[5]
        });
    }
    return activePods;

}

function getPods (callback) {
    exec(`kubectl get pods${ kubeConfig ? ' --kubeconfig=' + kubeConfig : ''}${ namespace ? ' --namespace=' + namespace : ''}`, function (error, stdout, stderr) {
        if (error || stderr) {
            timeLog(chalk.red(`Network error when getting pods`));
            callback(true);
        } else {
            callback(false, parsePods(stdout));
        }
    });
}

function getNiceState(pod) {
    let r = pod.ready ? chalk.green('Ready') : chalk.red('Not ready');
    r += ', ';
    switch (pod.state) {
        case 'CrashLoopBackOff':
        case 'Error':
            r += chalk.red(pod.state);
            break;
        case 'Running':
            r += chalk.green('Running');
            break;
        case 'ContainerCreating':
            r += chalk.yellow('ContainerCreating');
            break;
        default:
            r += state;
            break;
    }
    return r;
}

function getExtraParams() {
    return `${ kubeConfig ? ' --kubeconfig=' + kubeConfig : ''}${ namespace ? ' --namespace=' + namespace : ''}`;
}

function getPodBuildNumber (podId, callback) {
    exec(`kubectl get pod ${podId} -o yaml${getExtraParams()}`, function (error, stdout, stderr) {
        if (error || stderr) {
            timeLog(`Network error when getting pod number`);
            console.error(error, stderr);
            callback(true);
        } else {
            const match = /image:.*-([\d]*)/.exec(stdout);
            if (match) {
                callback(false, match[1]);
            } else {
                callback(true);
            }
        }
    });
}

function updatePodBuildNumber (pod, buildNumber, originalBuild) {
    exec(`kubectl get pod ${pod.id} -o yaml${getExtraParams()} | sed 's/\\(image: .*\\):.*$/\\1:build-${buildNumber}/' | kubectl${getExtraParams()} replace -f -`,  function (error, stdout, stderr) {
        if (error || stderr) {
            timeLog(`Error while updating ${pod.id}`);
            console.error(error, stderr);
        } else {
            timeLog(`Pod ${chalk.cyan(pod.id)} has been updated from build ${chalk.magenta(originalBuild)} to build ${chalk.magenta(buildNumber)}, waiting for it to restart...`);

            const checkIfPodIsUp = () => {
                getPods((error, pods) => {
                   if (!error) {
                       const updatedPod = _.find(pods, { id: pod.id });
                       if (!updatedPod) {
                           timeLog(`Pod ${chalk.cyan(pod.id)} was eliminated!`);
                       } else {
                           if (updatedPod.restarts > pod.restarts || pod.state != updatedPod.state || pod.ready != updatedPod.ready) {
                               if (updatedPod.state == 'Error' || updatedPod.state == 'CrashLoopBackOff') {
                                   timeLog(`Pod ${chalk.cyan(pod.id)} went into ${chalk.red(updatedPod.state)} state!`);
                               } else {
                                   if (updatedPod.state = 'Running' && updatedPod.ready) {
                                       timeLog(`Pod ${chalk.cyan(pod.id)} has been restarted and is now running build ${chalk.magenta(buildNumber)}`);
                                   } else {
                                       setTimeout(checkIfPodIsUp, 2000);
                                   }
                               }
                           } else {
                               setTimeout(checkIfPodIsUp, 2000);
                           }
                       }
                   }
                });
            };

            setTimeout(checkIfPodIsUp, 2000);
        }
    });

}

try {
    const args = process.argv.slice(2);
    let podsToUpdate = [];

    args.forEach(arg => {
        if (arg.match(/--kubeconfig=[^\s]*?/)) {
            kubeConfig = arg.split('=')[1];
        } else if (arg.match(/--namespace=[a-zA-z]*?/)) {
            namespace = arg.split('=')[1];
        } else {
            podsToUpdate.push(arg.split('='));
        }
    });

    if (podsToUpdate.length == 0) {
        throw 'No pod names provided';
    }

    if (kubeConfig) {
        timeLog(`Using config ${kubeConfig}`);
    }

    if (namespace) {
        timeLog(`Using namespace ${namespace}`);
    }

    getPods((error, pods) => {
        if (error) {
            process.exit();
        } else {
            podsToUpdate.forEach(podInfo => {
                const podIds = _.filter(pods, (pod) => {
                    return pod.id.toLowerCase().startsWith(podInfo[0]);
                });
                if (podIds.length) {

                    const uniqueNames = _.uniqBy(podIds, 'name');

                    if (uniqueNames.length > 1) {
                        timeLog(chalk.red(`More than one pod matches '${podInfo[0]}': ${(_.flatMap(uniqueNames, 'name')).join(', ')}`));
                    } else {
                        podIds.forEach(podId => {
                            getPodBuildNumber(podId.id, (error, buildNumber)=> {
                                if (error) {
                                    timeLog(chalk.red(`Cannot get build number for pod ${podId.id}`));
                                } else {
                                    if (podInfo.length > 1) {
                                        if (podInfo[1] == buildNumber) {
                                            timeLog(`Pod ${chalk.cyan(podId.id)} is already on build ${chalk.magenta(buildNumber)}`);
                                        } else {
                                            updatePodBuildNumber(podId, podInfo[1], buildNumber);
                                        }
                                    }  else {
                                        timeLog(`Pod ${chalk.cyan(podId.id)} (${getNiceState(podId)}) is on build ${chalk.magenta(buildNumber)}`);
                                    }
                                }
                            });
                        })
                    }
                } else {
                    timeLog(chalk.red(`Could not find any pod that start with ${podInfo}`));
                }
            });
        }
    })
} catch (error) {
    timeLog(chalk.red(error));
}
