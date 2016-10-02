# Kubeimage

A small cli utility to get/update deployment images in Kubernetes.

## Installation

```
npm i kubeimage -g
```

## Usage:

```
kubeimage <podname>=[<new-build-number>]... [--timeout=600] [--namespace=<kube-namespace>] [--kubeconfig=<kubeconfig>]
```

Timeout (in seconds, default 600) is amount of time that tool waits for pods to come up before it fails with error.
When no build number is provided the tool will output current build number for deployment and pods.
Note: images have to follow `build-<number>` naming convention.

