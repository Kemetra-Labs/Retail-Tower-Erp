const HtmlWebpackPlugin = require("html-webpack-plugin");
const InlineChunkHtmlPlugin = require("./webpack/InlineChunkHtmlPlugin");
const TerserPlugin = require("terser-webpack-plugin");
const path = require("path");

module.exports = (env, argv) => ({
  mode: argv.mode === "production" ? "production" : "development",

  entry: {
    ui: "./src/index.tsx",
  },

  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: "ts-loader",
          options: { transpileOnly: true },
        },
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: [
          "style-loader",
          "css-loader",
          {
            loader: "postcss-loader",
            options: {
              postcssOptions: {
                // Keep logical properties (inline-start, margin-inline, ...): Arabic mode is RTL and the
                // default preset rewrites them into left-to-right physical properties.
                plugins: [["postcss-preset-env", { features: { "logical-properties-and-values": false } }]],
              },
            },
          },
        ],
      },
      {
        test: /\.woff2$/,
        type: "asset/inline",
      },
      {
        // The template used url-loader (not an authorized dependency);
        // webpack 5 inlines assets natively.
        test: /\.(png|jpg|gif|webp|svg)$/,
        type: "asset/inline",
      },
    ],
  },

  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          output: { ascii_only: true },
        },
      }),
    ],
    usedExports: true,
  },

  resolve: { extensions: [".tsx", ".ts", ".jsx", ".js"] },

  output: {
    filename: "[name].js",
    path: path.resolve(__dirname, "dist"),
    publicPath: "",
  },

  plugins: [
    new HtmlWebpackPlugin({
      template: "./src/index.html",
      filename: "index.html",
      chunks: ["ui"],
      cache: false,
      inject: "body",
    }),
    new InlineChunkHtmlPlugin(HtmlWebpackPlugin, [/ui/]),
  ],

  devServer: {
    compress: true,
    port: 9000,
    static: { directory: path.join(__dirname, "dist") },
  },
});
