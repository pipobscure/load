import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
export default {
    input: './src/loader.ts',
    external: /^node:/,
    output:{
        format:'cjs',
        file:'./src/sea-script.js'
    },
    plugins: [
        nodeResolve(),
        typescript({
             compilerOptions: {
                rewriteRelativeImportExtensions: true,
                target: "esnext",
                sourceMap: false,
		        declaration: false,
		   
                declarationMap: false,
                composite:false
            }
        })
    ]
  }