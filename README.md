# @pipobscure/load

This is a node.js loader that can be used to package applications into self-contained bundles, execute those bundles and create Single Executable Applications from them.

## Usage

Install into your project like normal:

```
npm install --save-dev @pipopbscure/load
```

### Creating Bundles and Executables

```
MODULE_ARCHIVE=my-bundle.zip node --import=@pipobscure/load ./lib/my-app.js
```

This will create a zip-file that includes all the sources that have been loaded while this application was run. This zip bundle can then be run directly from the bundle.

```
node --import=@pipobscure/load ./my-bundle.zip
```

Once you have the bundle you can then inject it into node.js to create a single executable application.

```
npm exec --package=@pipobscure/load inject my-executable ./my-bundle.zip
```

### Asset Management

This also exposes a way to get assets that may have been included when bundling. When the application has not been injected yet, this works by using a directory containing zip-files.

```
ASSETS=./assets/ node --import=@pipobscure/load ./lib/my-app.js
```

The `ASSETS` environment variable defaults to the current working directory.

If there was a zip-file in that folder called `my-files.zip` containing `data.txt` then you can access it from code like this:

```
const dataBuffer = globalThis.Asset.get('asset:my-files.zip#/data.txt');
console.log(dataBuffer.toString('utf-8));
```

The url has the protocol `asset:` followed by the zip-file name, followed by `#` and the path of the file in the zip-archive.

In a single executable application, these asset files can be injected using:

```
npm exec --package=@pipobscure/load inject my-executable ./my-bundle.zip $(find ./assets -type f)
```
