#! /usr/bin/env node

'use strict';

const exec = require('child_process').exec;
const chalk = require('chalk');
const timestamp = require('time-stamp');
const async = require('async');
const _ = require('lodash');

let namespace;
let kubeConfig;

function timeLog (line) {
    console.log(`[${chalk.grey(timestamp('HH:mm:ss'))}] ${line}`);
}

const maxExecRetries = 30;
const execDelay = 2000;

function execRetry(name, command, callback, onError, tryNumber) {
    if (!tryNumber) {
        tryNumber = 0;
    }
    exec(command + `${ kubeConfig ? ' --kubeconfig=' + kubeConfig : ''}${ namespace ? ' --namespace=' + namespace : ''}`, function (error, stdout, stderr) {
        if (error || stderr) {
            tryNumber++;
            if (tryNumber > maxExecRetries) {
                if (onError) {
                    onError();
                } else {
                    timeLog(chalk.red(`Fatal error: out of retries performing ${name}, exiting...`, '\n', error || stderr));
                    process.exit(1);
                }
            } else {
                timeLog(chalk.red(`Network error when performing ${name}, retrying (${tryNumber})...`, '\n', error || stderr));
                setTimeout(() => {
                    execRetry(name, command, callback, onError, tryNumber);
                }, execDelay);
            }
        } else {
            callback(stdout);
        }
    });
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
    execRetry('get pods', 'kubectl get pods', function (stdout) {
        callback(false, parsePods(stdout));
    });
}

function getPodsWithBuildNumbers (deployments, callback) {
    getPods((error, pods) => {
        if (!error) {
            pods = _.filter(pods, (pod) => deployments.indexOf(pod.name) !== -1);
            execRetry('get pod', `kubectl get pod ${(_.flatMap(pods, 'id')).join(' ')} -o yaml`, (stdout) => {
                let m;
                let index = 0;
                const re = /containerStatuses:(?:.|\n)*?image:.*-([\d]*)/gm;
                while (m = re.exec(stdout)) {
                    if (pods[index]) {
                        pods[index].build = m[1];
                    }
                    index++;
                }
                callback(false, pods);
            });
        } else {
            callback(error);
        }
    });
}

function getDeployments (callback) {
    execRetry('get deployments', 'kubectl get deployments', function (stdout) {
        callback(false, parseDeployments(stdout));
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
        case 'Terminating':
            r += chalk.yellow('ContainerCreating');
            break;
        default:
            r += pod.state;
            break;
    }
    return r;
}

function getExtraParams () {
    return `${ kubeConfig ? ' --kubeconfig=' + kubeConfig : ''}${ namespace ? ' --namespace=' + namespace : ''}`;
}

function getPodBuildNumber (podId, callback) {
    execRetry('get pod', `kubectl get pod ${podId} -o yaml`, function (stdout) {
        const match = /image:.*-([\d]*)/.exec(stdout);
        if (match) {
            callback(false, match[1]);
        } else {
            callback(true);
        }
    });
}

function getDeploymentBuildNumber (serviceName, callback) {
    execRetry('get deployment', `kubectl get deployment ${serviceName} -o yaml`, function (stdout) {
        const match = /image:.*-([\d]*)/.exec(stdout);
        if (match) {
            callback(false, match[1]);
        } else {
            callback(true);
        }
    });
}

let pollingStarted = false;
let pollingTargets = [];
let pollingListeners = [];
let pollingHasErrors = false;
let pollInterval = 5000;
let pollTimeout = 600;
let pollStarted;

function pollPods () {

    if (!pollStarted) {
        pollStarted = Math.floor(new Date() / 1000);
    }

    if (Math.floor(new Date() / 1000) - pollStarted > pollTimeout) {
        timeLog(chalk.red(`Timeout reached while waiting for pods to restart for deployments: ${pollingTargets.join(', ')}`));
        process.exit(1);
    }

    getPodsWithBuildNumbers(pollingTargets, (error, pods) => {
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

function finishUpdate () {
    timeLog(`Completed updating deployments${!pollingHasErrors ? ' (no errors)' : ''}`);
    if (pollingHasErrors) {
        process.exit(1);
    }
    process.exit();
}

function updateDeploymentBuildNumber (deployment, newBuildNumber, originalBuild) {
    const serviceName = deployment.name;
    execRetry(`update deployment ${serviceName}`, `kubectl get deployment ${serviceName} -o yaml${getExtraParams()} | sed 's/\\(image: .*\\):.*$/\\1:build-${newBuildNumber}/' | kubectl${getExtraParams()} replace -f -`, function () {
        timeLog(`Deployment ${chalk.cyan(serviceName)} has been updated from build ${chalk.magenta(originalBuild)} to build ${chalk.magenta(newBuildNumber)}, waiting for pods to restart...`);
        healthCheckPods(deployment, newBuildNumber);
    }, () => {
        timeLog(`Fatal error while updating ${serviceName}`);
        _.pull(pollingTargets, serviceName);
        pollingHasErrors = true;
        console.error(error, stderr);
        if (!pollingTargets.length) {
            finishUpdate();
        }
    });
}

function healthCheckPods (deployment, buildNumber) {

    const serviceName = deployment.name;

    const listener = (pods) => {
        const currentPods = _.filter(pods, { name: serviceName });

        let totalPodsRunning = 0;
        let totalErrors = 0;

        currentPods.forEach(pod => {
            if (pod.build == buildNumber) {
                if (pod.state !== 'ContainerCreating' && pod.state !== 'Running' && pod.state !== 'Pending' && pod.state !== 'Terminating') {
                    timeLog(`Pod ${chalk.cyan(pod.id)} is ${chalk.red(pod.state)} state!`);
                    totalErrors++;
                } else if (pod.state == 'Running' && pod.ready) {
                    totalPodsRunning++;
                }
            }
        });

        if (totalPodsRunning + totalErrors == deployment.desiredCount) {
            if (totalErrors > 0) {
                pollingHasErrors = true;
                timeLog(`${totalErrors} of ${deployment.desiredCount} pod${totalErrors > 0 ? 's' : ''} failed to start for ${chalk.cyan(serviceName)}`);
            } else {
                timeLog(`All pods for ${chalk.cyan(serviceName)} are up to date`);
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

    async.parallel([
        function (callback) {
            getDeployments(callback);
        },
        function (callback) {
            getPodsWithBuildNumbers(_.flatMap(deploymentsToUpdate, 0), callback);
        }
    ], function (err, results) {
        if (err) {
            process.exit(1);
        }
        const deployments = results[0];
        let allPods = results[1];
        deploymentsToUpdate.forEach(deployment => {
            const foundDeployment = _.find(deployments, { name: deployment[0] });
            if (foundDeployment) {
                const serviceName = deployment[0];
                const pods = _.filter(allPods, { name: serviceName });

                getDeploymentBuildNumber(serviceName, (error, buildNumber)=> {
                    if (deployment.length > 1) {
                        pollingTargets.push(serviceName);
                        if (deployment[1] == buildNumber) {
                            timeLog(`Deployment ${chalk.cyan(serviceName)} is already configured to build ${chalk.magenta(buildNumber)}, checking if pods are up to date...`);
                            let running = 0;
                            pods.forEach(pod => {
                                if (pod.build == buildNumber && pod.state == 'Running' && pod.ready) {
                                    running++;
                                }
                            });
                            if (running == foundDeployment.desiredCount) {
                                timeLog(`All pods for ${chalk.cyan(serviceName)} are up to date`);
                            } else {
                                timeLog(`Pods for ${chalk.cyan(serviceName)} are not up to date, waiting...`);
                                healthCheckPods(foundDeployment, buildNumber);
                            }
                        } else {
                            updateDeploymentBuildNumber(foundDeployment, deployment[1], buildNumber);
                        }
                    } else {
                        timeLog(`Deployment ${chalk.cyan(serviceName)} is configured to build ${chalk.magenta(buildNumber)}`);
                        pods.forEach(pod => {
                            timeLog(`Pod ${chalk.cyan(pod.id)} (${getNiceState(pod)}) is running build ${chalk.magenta(pod.build)}`);
                        })
                    }
                });
            } else {
                timeLog(chalk.red(`Could not find '${deployment}' deployment`));
            }
        });
    });
} catch (error) {
    timeLog(chalk.red(error));
}
