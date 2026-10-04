// Copyright Epic Games, Inc. All Rights Reserved.

const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');
const fs = require('fs');

const pages = fs.readdirSync('./src', { withFileTypes: true })
	.filter(item => !item.isDirectory())
	.filter(item => path.parse(item.name).ext === '.html')
	.map(htmlFile => path.parse(htmlFile.name).name);

// Anything that has to land in the output root verbatim rather than through an asset rule:
// the PWA manifest, the service worker, and the icons the manifest names. `clean: true` wipes
// the output directory on every build, so these cannot simply be dropped in by hand.
const pwaPlugins = [
	new CopyWebpackPlugin({
		patterns: [
			{ from: './pwa/manifest.webmanifest', to: 'manifest.webmanifest' },
			{
				from: './pwa/sw.js',
				to: 'sw.js',
				// Bundles are emitted with stable names, so the cache name is the only thing that
				// can date a build. Stamping it here means each build invalidates the old cache.
				transform: (content) => content.toString().replace(/__PS_VERSION__/g, Date.now().toString()),
			},
			{ from: './src/assets/images/icon-192.png', to: 'images/icon-192.png' },
			{ from: './src/assets/images/icon-512.png', to: 'images/icon-512.png' },
			{ from: './src/assets/images/icon-maskable-512.png', to: 'images/icon-maskable-512.png' },
		],
	}),
	// The manifest link is added to every page here rather than in each template: a new page
	// should be installable without anyone remembering to add it, and the templates would
	// otherwise have to resolve a non-script asset through html-loader.
	new (class ManifestLinkPlugin {
		apply(compiler) {
			compiler.hooks.thisCompilation.tap('ManifestLinkPlugin', (compilation) => {
				compilation.hooks.processAssets.tap(
					{
						name: 'ManifestLinkPlugin',
						stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE,
					},
					(assets) => {
						for (const [name, asset] of Object.entries(assets)) {
							if (!name.endsWith('.html')) continue;
							const html = asset.source().toString();
							if (html.includes('rel="manifest"')) continue;
							const head = '    <link rel="manifest" href="./manifest.webmanifest">\n    <meta name="theme-color" content="#191715">\n</head>';
							compilation.updateAsset(
								name,
								new compiler.webpack.sources.RawSource(html.replace('</head>', head))
							);
						}
					}
				);
			});
		}
	})(),
];

module.exports = {
	entry: pages.reduce((config, page) => {
		config[page] = `./src/${page}.ts`;
		return config;
	}, {}),

    plugins: [].concat(pages.map((page) => new HtmlWebpackPlugin({
          title: `${page}`,
          template: `./src/${page}.html`,
          filename: `${page}.html`,
          chunks: [page],
    }), )).concat(pwaPlugins),

    module: {
      rules: [
        {
          test: /\.tsx?$/,
          loader: 'ts-loader',
          exclude: [
            /node_modules/,
          ],
          options: {
            configFile: "tsconfig.esm.json"
          }
        },
        {
          test: /\.html$/i,
          use: 'html-loader'
        },
        {
          test: /\.css$/,
          type: 'asset/resource',
          generator: {
            filename: 'css/[name][ext]'
          }
        },
        {
          test: /\.(png|svg|jpg|jpeg|gif)$/i,
          type: 'asset/resource',
          generator: {
            filename: 'images/[name][ext]'
          }
        }
      ],
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js', '.svg', '.json'],
    },
    output: {
      filename: '[name].js',
      library: 'epicgames-frontend',
      libraryTarget: 'umd',
      path: process.env.WEBPACK_OUTPUT_PATH ? path.resolve(process.env.WEBPACK_OUTPUT_PATH) : path.resolve(__dirname, '../../../SignallingWebServer/www'),
      clean: true,
      globalObject: 'this',
      hashFunction: 'xxhash64',
    },
    experiments: {
      futureDefaults: true
    },
	devServer: {
    	static: {
    		directory: path.join(__dirname, '../../../SignallingWebServer/www'),
    	},
    },
}
