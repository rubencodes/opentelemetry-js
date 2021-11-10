/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type * as grpcTypes from 'grpc';
import {
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
  InstrumentationBase,
  isWrapped,
} from '@opentelemetry/instrumentation';
import {
  GrpcInternalClientTypes,
  ServerCallWithMeta,
  SendUnaryDataCallback,
  GrpcClientFunc,
} from './types';
import { GrpcInstrumentationConfig } from '../types';
import {
  context,
  propagation,
  SpanOptions,
  SpanKind,
  trace,
} from '@opentelemetry/api';
import {
  clientStreamAndUnaryHandler,
  shouldNotTraceServerCall,
  serverStreamAndBidiHandler,
} from './serverUtils';
import {
  makeGrpcClientRemoteCall,
  getMetadata,
  getMethodsToWrap,
} from './clientUtils';
import { _methodIsIgnored } from '../utils';
import { AttributeNames } from '../enums/AttributeNames';

/**
 * Holding reference to grpc module here to access constant of grpc modules
 * instead of just requiring it avoid directly depending on grpc itself.
 */
let grpcClient: typeof grpcTypes;

export class GrpcNativeInstrumentation extends InstrumentationBase<
  typeof grpcTypes
> {
  constructor(
    name: string,
    version: string,
    config?: GrpcInstrumentationConfig
  ) {
    super(name, version, config);
  }

  init() {
    return [
      new InstrumentationNodeModuleDefinition<typeof grpcTypes>(
        'grpc',
        ['1.*'],
        (moduleExports, version) => {
          this._diag.debug(`Applying patch for grpc@${version}`);
          grpcClient = moduleExports;

          if (isWrapped(moduleExports.Server.prototype.register)) {
            this._unwrap(moduleExports.Server.prototype, 'register');
          }
          this._wrap(
            moduleExports.Server.prototype,
            'register',
            this._patchServer(moduleExports) as any
          );
          // Wrap the externally exported client constructor
          if (isWrapped(moduleExports.makeGenericClientConstructor)) {
            this._unwrap(moduleExports, 'makeGenericClientConstructor');
          }
          this._wrap(
            moduleExports,
            'makeGenericClientConstructor',
            this._patchClient()
          );
          if (isWrapped(moduleExports.loadPackageDefinition)) {
            this._unwrap(moduleExports, 'loadPackageDefinition');
          }
          this._wrap(
            moduleExports,
            'loadPackageDefinition',
            this._patchLoadPackageDefinition(moduleExports)
          );
          return moduleExports;
        },
        (moduleExports, version) => {
          if (moduleExports === undefined) return;
          this._diag.debug(`Removing patch for grpc@${version}`);

          this._unwrap(moduleExports.Server.prototype, 'register');
        },
        this._getInternalPatchs()
      ),
    ];
  }

  override getConfig(): GrpcInstrumentationConfig {
    return super.getConfig();
  }

  private _getInternalPatchs() {
    const onPatch = (
      moduleExports: GrpcInternalClientTypes,
      version?: string
    ) => {
      this._diag.debug(`Applying internal patch for grpc@${version}`);
      if (isWrapped(moduleExports.makeClientConstructor)) {
        this._unwrap(moduleExports, 'makeClientConstructor');
      }
      this._wrap(moduleExports, 'makeClientConstructor', this._patchClient());
      return moduleExports;
    };
    const onUnPatch = (
      moduleExports?: GrpcInternalClientTypes,
      version?: string
    ) => {
      if (moduleExports === undefined) return;
      this._diag.debug(`Removing internal patch for grpc@${version}`);
      this._unwrap(moduleExports, 'makeClientConstructor');
    };
    return [
      new InstrumentationNodeModuleFile<GrpcInternalClientTypes>(
        'grpc/src/node/src/client.js',
        ['0.13 - 1.6'],
        onPatch,
        onUnPatch
      ),
      new InstrumentationNodeModuleFile<GrpcInternalClientTypes>(
        'grpc/src/client.js',
        ['^1.7'],
        onPatch,
        onUnPatch
      ),
    ];
  }

  private _patchServer(grpcModule: typeof grpcTypes) {
    const instrumentation = this;
    return (originalRegister: typeof grpcTypes.Server.prototype.register) => {
      instrumentation._diag.debug('patched gRPC server');

      return function register<RequestType, ResponseType>(
        this: grpcTypes.Server & { handlers: any },
        name: string,
        handler: grpcTypes.handleCall<RequestType, ResponseType>,
        serialize: grpcTypes.serialize<RequestType>,
        deserialize: grpcTypes.deserialize<RequestType>,
        type: string
      ) {
        const originalResult = originalRegister.apply(this, arguments as any);
        const handlerSet = this.handlers[name];

        instrumentation._wrap(
          handlerSet,
          'func',
          (originalFunc: grpcTypes.handleCall<RequestType, ResponseType>) => {
            return function func(
              this: typeof handlerSet,
              call: ServerCallWithMeta,
              callback: SendUnaryDataCallback
            ) {
              const self = this;
              if (shouldNotTraceServerCall.call(instrumentation, call, name)) {
                switch (type) {
                  case 'unary':
                  case 'client_stream':
                    return (originalFunc as Function).call(
                      self,
                      call,
                      callback
                    );
                  case 'server_stream':
                  case 'bidi':
                    return (originalFunc as Function).call(self, call);
                  default:
                    return originalResult;
                }
              }
              const spanName = `grpc.${name.replace('/', '')}`;
              const spanOptions: SpanOptions = {
                kind: SpanKind.SERVER,
              };

              instrumentation._diag.debug(`patch func: ${JSON.stringify(spanOptions)}`);

              context.with(
                propagation.extract(context.active(), call.metadata, {
                  get: (metadata, key) => metadata.get(key).map(String),
                  keys: metadata => Object.keys(metadata.getMap()),
                }),
                () => {
                  const span = instrumentation.tracer
                    .startSpan(spanName, spanOptions)
                    .setAttributes({
                      [AttributeNames.GRPC_KIND]: spanOptions.kind,
                    });

                  context.with(trace.setSpan(context.active(), span), () => {
                    switch (type) {
                      case 'unary':
                      case 'client_stream':
                        return clientStreamAndUnaryHandler(
                          grpcModule,
                          span,
                          call,
                          callback,
                          originalFunc,
                          self
                        );
                      case 'server_stream':
                      case 'bidi':
                        return serverStreamAndBidiHandler(
                          span,
                          call,
                          originalFunc,
                          self
                        );
                      default:
                        break;
                    }
                  });
                }
              );
            };
          }
        );

        return originalResult;
      };
    };
  }

  private _patchClient() {
    const instrumentation = this;
    return (original: typeof grpcTypes.makeGenericClientConstructor): never => {
      instrumentation._diag.debug('patching client');
      return function makeClientConstructor(
        this: typeof grpcTypes.Client,
        methods: { [key: string]: { originalName?: string } },
        _serviceName: string,
        _options: grpcTypes.GenericClientOptions
      ) {
        const client = original.apply(this, arguments as any);
        instrumentation._massWrap(
          client.prototype as never,
          instrumentation._getMethodsToWrap(client, methods) as never[],
          instrumentation._getPatchedClientMethods() as any
        );
        return client;
      } as never;
    };
  }

  private _getMethodsToWrap(
    client: typeof grpcTypes.Client,
    methods: { [key: string]: { originalName?: string } }
  ): string[] {
    const methodList: string[] = [];

    // For a method defined in .proto as "UnaryMethod"
    Object.entries(methods).forEach(([name, { originalName }]) => {
      if (!_methodIsIgnored(name, this.getConfig().ignoreGrpcMethods)) {
        methodList.push(name); // adds camel case method name: "unaryMethod"
        if (
          originalName &&
          // eslint-disable-next-line no-prototype-builtins
          client.prototype.hasOwnProperty(originalName) &&
          name !== originalName // do not add duplicates
        ) {
          // adds original method name: "UnaryMethod",
          methodList.push(originalName);
        }
      }
    });
    return methodList;
  }

  /**
   * Entry point for client patching for grpc.loadPackageDefinition(...)
   * @param this - GrpcJsPlugin
   */
  private _patchLoadPackageDefinition(grpcClient: typeof grpcTypes) {
    const instrumentation = this;
    instrumentation._diag.debug('patching loadPackageDefinition');
    return (original: typeof grpcTypes.loadPackageDefinition) => {
      return function patchedLoadPackageDefinition(
        this: null,
        packageDef: grpcTypes.PackageDefinition
      ) {
        const result: grpcTypes.GrpcObject = original.call(
          this,
          packageDef
        ) as grpcTypes.GrpcObject;
        instrumentation._patchLoadedPackage(grpcClient, result);
        return result;
      } as typeof grpcTypes.loadPackageDefinition;
    };
  }

  private _getPatchedClientMethods() {
    const instrumentation = this;
    return (original: GrpcClientFunc) => {
      instrumentation._diag.debug('patch all client methods');
      return function clientMethodTrace(this: grpcTypes.Client) {
        const name = `grpc.${(original.path as string | undefined)?.replace(
          '/',
          ''
        )}`;
        const args = Array.prototype.slice.call(arguments);
        const metadata = getMetadata(grpcClient, original, args);
        const span = instrumentation.tracer.startSpan(name, {
          kind: SpanKind.CLIENT,
        });
        return context.with(trace.setSpan(context.active(), span), () =>
          makeGrpcClientRemoteCall(
            grpcClient,
            original,
            args,
            metadata,
            this
          )(span)
        );
      };
    };
  }

  /**
   * Utility function to patch *all* functions loaded through a proto file.
   * Recursively searches for Client classes and patches all methods, reversing the
   * parsing done by grpc.loadPackageDefinition
   * https://github.com/grpc/grpc-node/blob/1d14203c382509c3f36132bd0244c99792cb6601/packages/grpc-js/src/make-client.ts#L200-L217
   */
  private _patchLoadedPackage(
    grpcClient: typeof grpcTypes,
    result: grpcTypes.GrpcObject
  ): void {
    Object.values(result).forEach((service) => {
      if (typeof service === 'function') {
        this._massWrap(
          service.prototype as never,
          getMethodsToWrap.call(
            this,
            service,
            (
              service as typeof grpcTypes.Client & {
                service: { [k: string]: { originalName: string } };
              }
            ).service
          ) as never[],
          this._getPatchedClientMethods.call(this) as any
        );
      } else if (typeof service.format !== 'string') {
        // GrpcObject
        this._patchLoadedPackage.call(
          this,
          grpcClient,
          service as grpcTypes.GrpcObject
        );
      }
    });
  }
}
