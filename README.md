# Kubeimage

A small cli utility to get/update images in Kubernetes.

## Installation

```
npm i kubeimage -g
```

## Usage:

```
kubeimage <podname>=[<new-build-number>]... [--namespace=<kube-namespace>] [--kubeconfig=<kubeconfig>]
```

When no build number is provided the tool will output current build number.
Note: images have to follow `build-<number>` naming convention.

