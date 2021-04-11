import { compile, registerHelper, RuntimeOptions } from 'handlebars';
import { resolve } from 'path';
import { IndexHtmlTransformContext, Plugin as VitePlugin, normalizePath, send } from 'vite';
import { Context, resolveContext } from './context';
import { registerPartials } from './partials';
import fs from 'fs';

type CompileArguments = Parameters<typeof compile>;
type CompileOptions = CompileArguments[1];

export interface HandlebarsPluginConfig {
  context?: Context;
  reloadOnPartialChange?: boolean;
  compileOptions?: CompileOptions;
  runtimeOptions?: RuntimeOptions;
  partialDirectory?: string | Array<string>;
}

export default function handlebars({
  context,
  reloadOnPartialChange = true,
  compileOptions,
  runtimeOptions,
  partialDirectory,
}: HandlebarsPluginConfig = {}): VitePlugin[] {
  // Keep track of what partials are registered
  const partialsSet = new Set<string>();

  let root: string;

  registerHelper('resolve-from-root', function (path) {
    return resolve(root, path);
  });

  return [
    {
      name: 'handlebars',

      configResolved(config) {
        root = config.root;
      },

      async handleHotUpdate({ server, file }) {
        if (reloadOnPartialChange && partialsSet.has(file)) {
          server.ws.send({
            type: 'full-reload',
          });

          return [];
        }
      },

      transformIndexHtml: {
        // Ensure Handlebars runs _before_ any bundling
        enforce: 'pre',

        async transform(html: string, ctx: IndexHtmlTransformContext): Promise<string> {
          if (partialDirectory) {
            await registerPartials(partialDirectory, partialsSet);
          }

          const template = compile(html, compileOptions);

          const resolvedContext = await resolveContext(context, normalizePath(ctx.path));
          const result = template(resolvedContext, runtimeOptions);

          return result;
        },
      },
    },
    {
      name: 'handlebars:serve',
      apply: 'serve',

      configureServer(viteDevServer) {
        // Custom middleware that checks to see if a .hbs file exists for a requested html file
        // If that .hbs file does exist then it transforms the content using Vite's transformIndexHtml function
        // and responds with the result
        // (Wrapped in a function because that tells Vite to add it after the internal middlewares)
        // A similar middleware is used internally by Vite: https://github.com/vitejs/vite/blob/main/packages/vite/src/node/server/middlewares/indexHtml.ts#L125
        return () => {
          viteDevServer.middlewares.use(async (req, res, next) => {
            const possibleHbsPath = root + req.url?.slice(0, -4) + 'hbs';

            if (
              req.url?.endsWith('.html') &&
              req.headers['sec-fetch-dest'] !== 'script' &&
              fs.existsSync(possibleHbsPath) &&
              !fs.existsSync(root + req.url)
            ) {
              try {
                let html = fs.readFileSync(possibleHbsPath, 'utf-8');
                html = await viteDevServer.transformIndexHtml(req.url, html);
                return send(req, res, html, 'html');
              } catch (e) {
                return next(e);
              }
            }

            next();
          });
        };
      },
    },
    {
      name: 'handlebars:build',
      apply: 'build',

      // Tells Rollup/Vite that when an html file that doesn't actually exist in the filesystem,
      // but a .hbs file with the same name does then consider it a virtual file
      resolveId(id) {
        const possibleHbsPath = id.slice(0, -4) + 'hbs';

        if (id.endsWith('.html') && fs.existsSync(possibleHbsPath) && !fs.existsSync(id)) {
          return id;
        }
      },
      // Allows Rollup to load content from the virtual html files we're telling it exists above
      load(id) {
        const possibleHbsPath = id.slice(0, -4) + 'hbs';

        if (id.endsWith('.html') && fs.existsSync(possibleHbsPath) && !fs.existsSync(id)) {
          return fs.readFileSync(possibleHbsPath, 'utf-8');
        }
      },
    },
  ];
}
