"use strict";

// Local replacement for react-dev-utils/InlineChunkHtmlPlugin (same behaviour,
// no dependency). Replaces <script src="X"> tags whose asset name matches one of
// `tests` with an inline <script> holding the asset source. The asset is left in
// the compilation here is deleted once the HTML is generated, so only index.html
// is emitted (the original left the chunk on disk).
class InlineChunkHtmlPlugin {
  constructor(htmlWebpackPlugin, tests) {
    this.htmlWebpackPlugin = htmlWebpackPlugin;
    this.tests = tests;
  }

  inlineTag(publicPath, assets, tag) {
    if (tag.tagName !== "script" || !(tag.attributes && tag.attributes.src)) {
      return tag;
    }
    const name = publicPath
      ? tag.attributes.src.replace(publicPath, "")
      : tag.attributes.src;
    if (!this.tests.some((test) => name.match(test))) return tag;
    const asset = assets[name];
    if (asset == null) return tag;
    const source = String(asset.source()).replace(/<\/script/gi, "<\/script");
    return { tagName: "script", innerHTML: source, closeTag: true };
  }

  apply(compiler) {
    let publicPath = compiler.options.output.publicPath || "";
    if (publicPath && !publicPath.endsWith("/")) publicPath += "/";
    compiler.hooks.compilation.tap("InlineChunkHtmlPlugin", (compilation) => {
      const map = (tag) => this.inlineTag(publicPath, compilation.assets, tag);
      this.htmlWebpackPlugin
        .getHooks(compilation)
        .alterAssetTagGroups.tap("InlineChunkHtmlPlugin", (groups) => {
          groups.headTags = groups.headTags.map(map);
          groups.bodyTags = groups.bodyTags.map(map);
        });
      this.htmlWebpackPlugin
        .getHooks(compilation)
        .beforeEmit.tap("InlineChunkHtmlPlugin", (data) => {
          for (const name of Object.keys(compilation.assets)) {
            if (this.tests.some((test) => name.match(test))) {
              compilation.deleteAsset(name);
            }
          }
          return data;
        });
    });
  }
}

module.exports = InlineChunkHtmlPlugin;
