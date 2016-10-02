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

function parseDeployments (stdout) {
    let m;
    const re = /^([^\s]+)[\s]+([\d]+)/gm;
    const deployMents = [];
    while (m = re.exec(stdout)) {
        deployMents.push({
            name: m[1],
            desiredCount: m[2]
        });
    }
    return deployMents;

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
function getDeployments (callback) {
    exec(`kubectl get deployments${ kubeConfig ? ' --kubeconfig=' + kubeConfig : ''}${ namespace ? ' --namespace=' + namespace : ''}`, function (error, stdout, stderr) {
        if (error || stderr) {
            timeLog(chalk.red(`Network error when getting deployments`));
            callback(true);
        } else {
            callback(false, parseDeployments(stdout));
        }
    });
}

function getNiceState (pod) {
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

function getExtraParams () {
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

function getDeploymentBuildNumber (serviceName, callback) {
    exec(`kubectl get deployment ${serviceName} -o yaml${getExtraParams()}`, function (error, stdout, stderr) {
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

let pollingStarted = false;
let pollingTargets = [];
let pollingListeners = [];
let pollingHasErrors = false;
let pollInterval = 2000;
let pollTimeout = 600;
let pollStarted;

function pollPods() {

    if (!pollStarted) {
        pollStarted = Math.floor(new Date() / 1000);
    }

    if (Math.floor(new Date() / 1000) - pollStarted > pollTimeout) {
        timeLog(chalk.red(`Timeout reached while waiting for pods to restart for deployments: ${pollingTargets.join(', ')}`));
        process.exit(1);
    }

    getPods((error, pods) => {
        if (!error) {
            pollingListeners.forEach(listener => {
                listener(pods);
            });
        }
        if (pollingTargets.length == 0) {
            finishUpdate();
        } else {
            setTimeout(pollPods, pollInterval);
        }
    });
}

function finishUpdate() {
    if (pollingHasErrors) {
        process.exit(1);
    }
    timeLog(`Completed updating deployments${!pollingHasErrors ? ' (no errors)' : ''}`);
    process.exit();
}

function updateDeploymentBuildNumber (deployment, buildNumber, originalBuild, oldPods) {
    const serviceName = deployment.name;
    exec(`kubectl get deployment ${serviceName} -o yaml${getExtraParams()} | sed 's/\\(image: .*\\):.*$/\\1:build-${buildNumber}/' | kubectl${getExtraParams()} replace -f -`, function (error, stdout, stderr) {
        if (error || stderr) {
            timeLog(`Error while updating ${pod.id}`);
            _.pull(pollingTargets, serviceName);
            pollingHasErrors = true;
            console.error(error, stderr);
            if (!pollingTargets.length) {
                finishUpdate();
            }
        } else {
            timeLog(`Deployment ${chalk.cyan(serviceName)} has been updated from build ${chalk.magenta(originalBuild)} to build ${chalk.magenta(buildNumber)}, waiting for pods to restart...`);

            const listener = (pods) => {
                const currentPods = _.filter(pods, (pod) => {
                    return pod.id.toLowerCase().startsWith(serviceName);
                });

                _.pullAllBy(currentPods, oldPods, 'id');

                let totalPodsRunning = 0;
                let totalErrors = 0;

                if (currentPods.length) {
                    currentPods.forEach(pod => {
                        if (pod.state !== 'ContainerCreating' && pod.state !== 'Running' && pod.state !== 'Pending') {
                            timeLog(`Pod ${chalk.cyan(pod.id)} went into ${chalk.red(pod.state)} state!`);
                            totalErrors++;
                        } else if (pod.state == 'Running' && pod.ready) {
                            totalPodsRunning++;
                        }
                    })
                }

                if (totalPodsRunning + totalErrors == deployment.desiredCount) {
                    if (totalErrors > 0) {
                        pollingHasErrors = true;
                        timeLog(`${totalErrors} of ${deployment.desiredCount} pod${totalErrors > 0 ? 's' : ''} failed to restart for ${chalk.cyan(serviceName)}`);
                    } else {
                        timeLog(`All pods for ${chalk.cyan(serviceName)} have been restarted`);
                    }
                    _.pull(pollingTargets, serviceName);
                    _.pull(pollingListeners, listener);
                }
            };

            pollingListeners.push(listener);

            if (!pollingStarted) {
                pollingStarted = true;
                pollPods();
            }
        }
    });

}

try {
    const args = process.argv.slice(2);
    let deploymentsToUpdate = [];

    args.forEach(arg => {
        if (arg.match(/--kubeconfig=[^\s]*?/)) {
            kubeConfig = arg.split('=')[1];
        } else if (arg.match(/--namespace=[a-zA-z]*?/)) {
            namespace = arg.split('=')[1];
        } else if (arg.match(/--timeout=[a-zA-z]*?/)) {
            pollTimeout = arg.split('=')[1];
        } else {
            deploymentsToUpdate.push(arg.split('='));
        }
    });

    if (deploymentsToUpdate.length == 0) {
        throw 'No pod names provided';
    }

    if (kubeConfig) {
        timeLog(`Using config ${kubeConfig}`);
    }

    if (namespace) {
        timeLog(`Using namespace ${namespace}`);
    }

    getDeployments((error, deployments) => {
        if (error) {
            process.exit(1);
        } else {
            deploymentsToUpdate.forEach(deployment => {
                const foundDeployment = _.find(deployments, { name: deployment[0] } );
                if (foundDeployment) {

                    const serviceName = deployment[0];

                    getPods((error, pods) => {
                        if (error) {
                            process.exit(1);
                        }
                        pods = _.filter(pods, { name: deployment[0]});
                        if (deployment.length > 1) {
                            getDeploymentBuildNumber(serviceName, (error, buildNumber)=> {
                                if (deployment[1] == buildNumber) {
                                    timeLog(`Deployment ${chalk.cyan(serviceName)} is already configured to build ${chalk.magenta(buildNumber)}`);
                                } else {
                                    pollingTargets.push(deployment[0]);
                                    updateDeploymentBuildNumber(foundDeployment, deployment[1], buildNumber, pods);
                                }
                            });
                        } else {
                            getDeploymentBuildNumber(serviceName, (error, buildNumber)=> {
                                timeLog(`Deployment ${chalk.cyan(serviceName)} is configured to build ${chalk.magenta(buildNumber)}`);
                                pods.forEach(pod => {
                                    getPodBuildNumber(pod.id, (error, buildNumber)=> {
                                        if (error) {
                                            timeLog(chalk.red(`Cannot get build number for pod ${pod.id}`));
                                        } else {
                                            timeLog(`Pod ${chalk.cyan(pod.id)} (${getNiceState(pod)}) is running build ${chalk.magenta(buildNumber)}`);
                                        }
                                    });
                                })
                            });
                        }
                    });
                } else {
                    timeLog(chalk.red(`Could not find '${deployment}' deployment`));
                }
            });
        }
    })
} catch (error) {
    timeLog(chalk.red(error));
}
