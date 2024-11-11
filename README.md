# @pibobscure/load

This is an experimental ESM/CJS loader meant to be used to run a package (finding the entry-point via *package.json*) from

 * a folder (useful to create zip-files of files used)
 * a zip-file (useful for deployment and as a start to SEA)
 * an sea blob (embedded into the node binary)

This ensures that the project is run in the exact same way when run froma  folder in devleopment as it is once deployed as a zip-file or an SEA.

This requires a [*possible future version*](https://github.com/pipobscure/node/pull/1) of node that has the correctly exported utilities from `node:module` (`Module.getCJSParser()` and `Module.containsModuleSyntax()`) as well as modernized versions of `SourceTextModule` and `SyntheticModule` from `node:vm` that are capable of having `module.link()` and `module.evaluate()` to complete either synchronously or asynchronously depending on whether the provided *linker* method returns a `Promise` or there is a top-level `await`.

The possible value of this are:

1. a good way to develop and deploy SEA applications

That's because the execution in development is identical to the execution after deployment. In addition the loader can keep a record of all the files being used, which should make tree-shaking (on a file basis) easily possible.

2. a possibly better way to deploy applications

That's because everything is installed and collected and can be audited at packaging time. This in turn can be useful to prevent supply-chain attacks. At package time a developer can `npm install` their dependencies and then audit them for correctness or maliciousness. When the application is then packaged (by running from the folder with `process.env.NODE_PACKAGE` containing the target zip-file) it has known dependencies and can now be deployed without further dependencies on external supply chains.

