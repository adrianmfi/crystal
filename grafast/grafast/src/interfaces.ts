import type LRU from "@graphile/lru";
import type EventEmitter from "eventemitter3";
import type { PluginHook } from "graphile-config";
import type {
  ASTNode,
  DocumentNode,
  ExecutionArgs as GraphQLExecutionArgs,
  FragmentDefinitionNode,
  GraphQLArgs,
  GraphQLArgument,
  GraphQLArgumentConfig,
  GraphQLError,
  GraphQLField,
  GraphQLFieldConfig,
  GraphQLInputField,
  GraphQLInputFieldConfig,
  GraphQLInputObjectType,
  GraphQLInputType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLOutputType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLType,
  OperationDefinitionNode,
  ValueNode,
  VariableNode,
} from "graphql";

import type { Bucket, RequestTools } from "./bucket.js";
import type { OperationPlan } from "./engine/OperationPlan.js";
import type { SafeError } from "./error.js";
import type { ExecutableStep, ListCapableStep, ModifierStep } from "./step.js";
import type { __InputDynamicScalarStep } from "./steps/__inputDynamicScalar.js";
import type {
  __InputListStep,
  __InputObjectStep,
  __InputObjectStepWithDollars,
  __InputStaticLeafStep,
  __TrackedValueStep,
  __TrackedValueStepWithDollars,
  ConstantStep,
} from "./steps/index.js";
import type { GrafastInputObjectType, GrafastObjectType } from "./utils.js";

type PromiseOrValue<T> = T | Promise<T>;

export interface GrafastTimeouts {
  /**
   * How many milliseconds should we allow for planning. Remember: planning is
   * synchronous, so whilst it is happening the event loop is blocked.
   */
  planning?: number;

  /**
   * How many milliseconds should we allow for execution. We will only check
   * this immediately before triggering the execution of an asynchronous step,
   * and if it is exceeded it will only prevent the execution of asynchronous
   * steps, not synchronous ones.
   *
   * IMPORTANT: since we only check this _before_ an asynchronous step
   * executes, there's nothing to stop an asynchronous step from continuing to
   * execute long after the timeout has expired - therefore it's the
   * responsibility of each step to abort itself if it goes over the allocated
   * time budget (which is detailed in `ExecutionExtra.stopTime`).
   */
  execution?: number;

  // We do not currently have an "output" timeout limit; though output is
  // synchronous it's typically so fast that no timeout is required.
}

export const $$queryCache = Symbol("queryCache");

/**
 * We store the cache directly onto the GraphQLSchema so that it gets garbage
 * collected along with the schema when it's not needed any more. To do so, we
 * attach it using this symbol.
 */
export const $$cacheByOperation = Symbol("cacheByOperation");
export type Fragments = {
  [key: string]: FragmentDefinitionNode;
};
export type OperationPlanOrError =
  | OperationPlan
  | Error
  | SafeError<
      | { [$$timeout]: number; [$$ts]: number }
      | { [$$timeout]?: undefined; [$$ts]?: undefined }
      | undefined
    >;

/**
 * This represents the list of possible operationPlans for a specific document.
 *
 * @remarks
 *
 * It also includes the fragments for validation, but generally we trust that
 * if the OperationDefinitionNode is the same then the request is equivalent.
 */
export interface CacheByOperationEntry {
  /**
   * Implemented as a linked list so the hot operationPlans can be kept at the top of the
   * list, and if the list grows beyond a maximum size we can drop the last
   * element.
   */
  possibleOperationPlans: LinkedList<OperationPlanOrError> | null;
  fragments: Fragments;
}

export interface LinkedList<T> {
  value: T;
  next: LinkedList<T> | null;
}

export const $$hooked = Symbol("hookArgsApplied");

declare global {
  namespace Grafast {
    type ExecutionArgs = Pick<
      GraphQLExecutionArgs,
      "schema" | "document" | "rootValue" | "variableValues" | "operationName"
    > & { [$$hooked]?: boolean; contextValue: Grafast.Context };

    /**
     * Details about the incoming GraphQL request - e.g. if it was sent over an
     * HTTP request, the request itself so headers can be interrogated.
     *
     * It's anticipated this will be expanded via declaration merging, e.g. if
     * your server is Koa then a `koaCtx` might be added.
     */
    interface RequestContext {}

    /**
     * The GraphQL context our schemas expect, generally generated from details in Grafast.RequestContext
     */
    interface Context {}

    interface FieldExtensions {
      plan?: FieldPlanResolver<any, any, any>;
      subscribePlan?: FieldPlanResolver<any, any, any>;
    }

    interface ArgumentExtensions {
      // fooPlan?: ArgumentPlanResolver<any, any, any, any, any>;
      inputPlan?: ArgumentInputPlanResolver;
      applyPlan?: ArgumentApplyPlanResolver;
      autoApplyAfterParentPlan?: boolean;
      autoApplyAfterParentSubscribePlan?: boolean;
    }

    interface InputObjectTypeExtensions {
      inputPlan?: InputObjectTypeInputPlanResolver;
    }

    interface InputFieldExtensions {
      // fooPlan?: InputObjectFieldPlanResolver<any, any, any, any>;
      inputPlan?: InputObjectFieldInputPlanResolver;
      applyPlan?: InputObjectFieldApplyPlanResolver;
      autoApplyAfterParentInputPlan?: boolean;
      autoApplyAfterParentApplyPlan?: boolean;
    }

    interface ObjectTypeExtensions {
      assertStep?:
        | ((step: ExecutableStep) => asserts step is ExecutableStep)
        | { new (...args: any[]): ExecutableStep }
        | null;
    }

    interface EnumTypeExtensions {}

    interface EnumValueExtensions {
      /**
       * EXPERIMENTAL!
       *
       * @internal
       */
      applyPlan?: EnumValueApplyPlanResolver<any>;
    }

    interface ScalarTypeExtensions {
      plan?: ScalarPlanResolver;
      inputPlan?: ScalarInputPlanResolver;
      /**
       * Set true if `serialize(serialize(foo)) === serialize(foo)` for all foo
       */
      idempotent?: boolean;
    }

    interface SchemaExtensions {
      /**
       * Maximum number of queries to store in this schema's query cache.
       */
      queryCacheMaxLength?: number;

      /**
       * The underlying query cache
       */
      [$$queryCache]?: LRU<string, DocumentNode | ReadonlyArray<GraphQLError>>;

      /**
       * Maximum number of operations to store an operation plan lookup cache for
       */
      operationsCacheMaxLength?: number;

      /**
       * Maximum number of operation plans to store in a single operation's cache
       */
      operationOperationPlansCacheMaxLength?: number;

      /**
       * The starting point for finding/storing the relevant OperationPlan for a request.
       */
      [$$cacheByOperation]?: LRU<
        OperationDefinitionNode,
        CacheByOperationEntry
      >;
    }
  }
  namespace GraphileConfig {
    interface GrafastOptions {
      /**
       * An object to merge into the GraphQL context. Alternatively, pass an
       * (optionally asynchronous) function that returns an object to merge into
       * the GraphQL context.
       */
      context?:
        | Partial<Grafast.Context>
        | ((
            ctx: Partial<Grafast.RequestContext>,
            args: Grafast.ExecutionArgs,
          ) => PromiseOrValue<Partial<Grafast.Context>>);

      /**
       * A list of 'explain' types that should be included in `extensions.explain`.
       *
       * - `plan` will cause the plan JSON to be included
       * - other values are dependent on the plugins in play
       *
       * If set to `true` then all possible explain types will be exposed.
       */
      explain?: boolean | string[];

      timeouts?: GrafastTimeouts;
    }
    interface Preset {
      /**
       * Options that control how `grafast` should execute your GraphQL
       * operations.
       */
      grafast?: GraphileConfig.GrafastOptions;
    }
    interface GrafastHooks {
      args: PluginHook<
        (event: {
          args: Grafast.ExecutionArgs;
          ctx: Grafast.RequestContext;
          resolvedPreset: GraphileConfig.ResolvedPreset;
        }) => PromiseOrValue<void>
      >;
    }
    interface Plugin {
      grafast?: {
        hooks?: GrafastHooks;
      };
    }
  }
}

/*
 * We register certain things (plans, etc) into the GraphQL "extensions"
 * property on the various GraphQL configs (type, field, argument, etc); this
 * uses declaration merging so that these can be accessed with types.
 */
declare module "graphql" {
  interface GraphQLFieldExtensions<_TSource, _TContext, _TArgs = any> {
    grafast?: Grafast.FieldExtensions;
  }

  interface GraphQLArgumentExtensions {
    grafast?: Grafast.ArgumentExtensions;
  }

  interface GraphQLInputObjectTypeExtensions {
    grafast?: Grafast.InputObjectTypeExtensions;
  }

  interface GraphQLInputFieldExtensions {
    grafast?: Grafast.InputFieldExtensions;
  }

  interface GraphQLObjectTypeExtensions<_TSource = any, _TContext = any> {
    grafast?: Grafast.ObjectTypeExtensions;
  }

  interface GraphQLEnumTypeExtensions {
    grafast?: Grafast.EnumTypeExtensions;
  }

  interface GraphQLEnumValueExtensions {
    grafast?: Grafast.EnumValueExtensions;
  }

  interface GraphQLScalarTypeExtensions {
    grafast?: Grafast.ScalarTypeExtensions;
  }

  interface GraphQLSchemaExtensions {
    grafast?: Grafast.SchemaExtensions;
  }
}

export const $$grafastContext = Symbol("context");
export const $$planResults = Symbol("planResults");
export const $$id = Symbol("id");
/** Return the value verbatim, don't execute */
export const $$verbatim = Symbol("verbatim");
/**
 * If we're sure the data is the right shape and valid, we can set this key and
 * it can be returned directly
 */
export const $$bypassGraphQL = Symbol("bypassGraphQL");
export const $$data = Symbol("data");
/**
 * For attaching additional metadata to the GraphQL execution result, for
 * example details of the plan or SQL queries or similar that were executed.
 */
export const $$extensions = Symbol("extensions");

/**
 * The "GraphQLObjectType" type name, useful when dealing with polymorphism.
 *
 * @internal
 */
export const $$concreteType = Symbol("concreteType");

/**
 * Set this key on a type if that type's serialization is idempotent (that is
 * to say `serialize(serialize(thing)) === serialize(thing)`). This means we
 * don't have to "roll-back" serialization if we need to fallback to graphql-js
 * execution.
 */
export const $$idempotent = Symbol("idempotent");

/**
 * The event emitter used for outputting execution events.
 */
export const $$eventEmitter = Symbol("executionEventEmitter");

/**
 * Used to indicate that an array has more results available via a stream.
 */
export const $$streamMore = Symbol("streamMore");

export const $$proxy = Symbol("proxy");

/**
 * If an error has this property set then it's safe to send through to the user
 * without being masked.
 */
export const $$safeError = Symbol("safeError");

/** The layerPlan used as a subroutine for this step */
export const $$subroutine = Symbol("subroutine");

/** For tracking the timeout a TimeoutError happened from */
export const $$timeout = Symbol("timeout");

/** For tracking _when_ the timeout happened (because once the JIT has warmed it might not need so long) */
export const $$ts = Symbol("timestamp");

/**
 * When dealing with a polymorphic thing we need to be able to determine what
 * the concrete type of it is, we use the $$concreteType property for that.
 */
export interface PolymorphicData<TType extends string = string, TData = any> {
  [$$concreteType]: TType;
  [$$data]?: TData;
}

export interface IndexByListItemStepId {
  [listItemStepId: number]: number;
}

// These values are just to make reading the code a little clearer
export type GrafastValuesList<T> = ReadonlyArray<T>;
export type PromiseOrDirect<T> = PromiseLike<T> | T;
export type GrafastResultsList<T> = ReadonlyArray<PromiseOrDirect<T>>;
export type GrafastResultStreamList<T> = ReadonlyArray<
  PromiseOrDirect<AsyncIterable<PromiseOrDirect<T>> | null> | PromiseLike<never>
>;

export type BaseGraphQLRootValue = any;
export interface BaseGraphQLVariables {
  [key: string]: unknown;
}
export interface BaseGraphQLArguments {
  [key: string]: any;
}
export type BaseGraphQLInputObject = BaseGraphQLArguments;

// TYPES: we need to work some TypeScript magic to know which callback forms are
// appropriate. Or split up FieldArgs.apply/applyEach/applyField or whatever.
export type TargetStepOrCallback =
  | ExecutableStep
  | ModifierStep
  | ((indexOrFieldName: number | string) => TargetStepOrCallback);

export type FieldArgs = {
  /** Gets the value, evaluating the `inputPlan` at each field if appropriate */
  get(path?: string | ReadonlyArray<string | number>): ExecutableStep;
  /** Gets the value *without* calling any `inputPlan`s */
  getRaw(path?: string | ReadonlyArray<string | number>): AnyInputStep;
  /** This also works (without path) to apply each list entry against $target */
  apply(
    $target: ExecutableStep | ModifierStep | (() => ModifierStep),
    path?: string | ReadonlyArray<string | number>,
  ): void;
} & AnyInputStepDollars;

export type InputStep<TInputType extends GraphQLInputType = GraphQLInputType> =
  GraphQLInputType extends TInputType
    ? AnyInputStep
    : TInputType extends GraphQLNonNull<infer U>
    ? Exclude<InputStep<U & GraphQLInputType>, ConstantStep<undefined>>
    : TInputType extends GraphQLList<GraphQLInputType>
    ?
        | __InputListStep<TInputType> // .at(), .eval(), .evalLength(), .evalIs(null)
        | __TrackedValueStep<any, TInputType> // .get(), .eval(), .evalIs(), .evalHas(), .at(), .evalLength(), .evalIsEmpty()
        | ConstantStep<undefined> // .eval(), .evalIs(), .evalIsEmpty()
    : TInputType extends GraphQLInputObjectType
    ?
        | __TrackedValueStepWithDollars<any, TInputType> // .get(), .eval(), .evalIs(), .evalHas(), .at(), .evalLength(), .evalIsEmpty()
        | __InputObjectStepWithDollars<TInputType> // .get(), .eval(), .evalHas(), .evalIs(null), .evalIsEmpty()
        | ConstantStep<undefined> // .eval(), .evalIs(), .evalIsEmpty()
    : // TYPES: handle the other types
      AnyInputStep;

export type AnyInputStep =
  | __TrackedValueStepWithDollars<any, GraphQLInputType> // .get(), .eval(), .evalIs(), .evalHas(), .at(), .evalLength(), .evalIsEmpty()
  | __InputListStep // .at(), .eval(), .evalLength(), .evalIs(null)
  | __InputStaticLeafStep // .eval(), .evalIs()
  | __InputDynamicScalarStep // .eval(), .evalIs()
  | __InputObjectStepWithDollars<GraphQLInputObjectType> // .get(), .eval(), .evalHas(), .evalIs(null), .evalIsEmpty()
  | ConstantStep<undefined>; // .eval(), .evalIs(), .evalIsEmpty()

export type AnyInputStepWithDollars = AnyInputStep & AnyInputStepDollars;

// TYPES: solve these lies
/**
 * Lies to make it easier to write TypeScript code like
 * `{ $input: { $user: { $username } } }` without having to pass loads of
 * generics.
 */
export type AnyInputStepDollars = {
  [key in string as `$${key}`]: AnyInputStepWithDollars;
};

export interface FieldInfo {
  field: GraphQLField<any, any, any>;
  schema: GraphQLSchema;
}

/**
 * Step resolvers are like regular resolvers except they're called beforehand,
 * they return plans rather than values, and they only run once for lists
 * rather than for each item in the list.
 *
 * The idea is that the plan resolver returns a plan object which later will
 * process the data and feed that into the actual resolver functions
 * (preferably using the default resolver function?).
 *
 * They are stored onto `<field>.extensions.grafast.plan`
 *
 * @returns a plan for this field.
 *
 * @remarks
 * We're using `TrackedObject<...>` so we can later consider caching these
 * executions.
 */
export type FieldPlanResolver<
  _TArgs extends BaseGraphQLArguments,
  TParentStep extends ExecutableStep | null,
  TResultStep extends ExecutableStep,
> = (
  $parentPlan: TParentStep,
  args: FieldArgs,
  info: FieldInfo,
) => TResultStep | null;

// TYPES: review _TContext
/**
 * Fields on input objects can have plans; the plan resolver is passed a parent plan
 * (from an argument, or from a parent input object) or null if none, and an
 * input plan that represents the value the user will pass to this field. The
 * resolver must return either a ModifierStep or null.
 */
export type InputObjectFieldInputPlanResolver<
  TResultStep extends ExecutableStep = ExecutableStep,
> = (
  input: FieldArgs,
  info: {
    schema: GraphQLSchema;
    entity: GraphQLInputField;
  },
) => TResultStep;

export type InputObjectFieldApplyPlanResolver<
  TFieldStep extends ExecutableStep | ModifierStep<any> =
    | ExecutableStep
    | ModifierStep<any>,
  TResultStep extends ModifierStep<
    ExecutableStep | ModifierStep<any>
  > | null | void = ModifierStep<
    ExecutableStep | ModifierStep<any>
  > | null | void,
> = (
  $fieldPlan: TFieldStep,
  input: FieldArgs,
  info: {
    schema: GraphQLSchema;
    entity: GraphQLInputField;
  },
) => TResultStep;

export type InputObjectTypeInputPlanResolver = (
  input: FieldArgs,
  info: {
    schema: GraphQLSchema;
    type: GraphQLInputObjectType;
  },
) => ExecutableStep;

// TYPES: review _TContext
/**
 * Arguments can have plans; the plan resolver is passed the parent plan (the
 * plan that represents the _parent_ field of the field the arg is defined on),
 * the field plan (the plan that represents the field the arg is defined on)
 * and an input plan that represents the value the user will pass to this
 * argument. The resolver must return either a ModifierStep or null.
 */
export type ArgumentInputPlanResolver<
  TParentStep extends ExecutableStep = ExecutableStep,
  TResultStep extends ExecutableStep = ExecutableStep,
> = (
  $parentPlan: TParentStep,
  input: FieldArgs,
  info: {
    schema: GraphQLSchema;
    entity: GraphQLArgument;
  },
) => TResultStep;

export type ArgumentApplyPlanResolver<
  TParentStep extends ExecutableStep = ExecutableStep,
  TFieldStep extends ExecutableStep | ModifierStep<any> =
    | ExecutableStep
    | ModifierStep<any>,
  TResultStep extends
    | ExecutableStep
    | ModifierStep<ExecutableStep | ModifierStep>
    | null
    | void =
    | ExecutableStep
    | ModifierStep<ExecutableStep | ModifierStep>
    | null
    | void,
> = (
  $parentPlan: TParentStep,
  $fieldPlan: TFieldStep,
  input: FieldArgs,
  info: {
    schema: GraphQLSchema;
    entity: GraphQLArgument;
  },
) => TResultStep;

/**
 * GraphQLScalarTypes can have plans, these are passed the field plan and must
 * return an executable plan.
 */
export type ScalarPlanResolver<
  TParentStep extends ExecutableStep = ExecutableStep,
  TResultStep extends ExecutableStep = ExecutableStep,
> = ($parentPlan: TParentStep, info: { schema: GraphQLSchema }) => TResultStep;

/**
 * GraphQLScalarTypes can have plans, these are passed the field plan and must
 * return an executable plan.
 */
export type ScalarInputPlanResolver<
  TResultStep extends ExecutableStep = ExecutableStep,
> = (
  $inputValue: InputStep,
  /*
    | __InputListStep
    | __InputStaticLeafStep
    | __InputDynamicScalarStep,
  */
  info: { schema: GraphQLSchema; type: GraphQLScalarType },
) => TResultStep;

/**
 * EXPERIMENTAL!
 *
 * NOTE: this is an `any` because we want to allow users to specify
 * subclasses of ExecutableStep but TypeScript only wants to allow
 * superclasses.
 *
 * @internal
 */
export type EnumValueApplyPlanResolver<
  TParentStep extends ExecutableStep | ModifierStep =
    | ExecutableStep
    | ModifierStep,
> = ($parent: TParentStep) => ModifierStep | void;

// TypeScript gets upset if we go too deep, so we try and cover the most common
// use cases and fall back to `any`
type OutputPlanForNamedType<TType extends GraphQLType> =
  TType extends GrafastObjectType<any, infer TStep, any>
    ? TStep
    : ExecutableStep;

export type OutputPlanForType<TType extends GraphQLOutputType> =
  TType extends GraphQLNonNull<GraphQLList<GraphQLNonNull<infer U>>>
    ?
        | ListCapableStep<any, OutputPlanForNamedType<U>>
        | ExecutableStep<ReadonlyArray<any>>
    : TType extends GraphQLNonNull<GraphQLList<infer U>>
    ?
        | ListCapableStep<any, OutputPlanForNamedType<U>>
        | ExecutableStep<ReadonlyArray<any>>
    : TType extends GraphQLList<GraphQLNonNull<infer U>>
    ?
        | ListCapableStep<any, OutputPlanForNamedType<U>>
        | ExecutableStep<ReadonlyArray<any>>
    : TType extends GraphQLList<infer U>
    ?
        | ListCapableStep<any, OutputPlanForNamedType<U>>
        | ExecutableStep<ReadonlyArray<any>>
    : TType extends GraphQLNonNull<infer U>
    ? OutputPlanForNamedType<U>
    : OutputPlanForNamedType<TType>;

// TypeScript gets upset if we go too deep, so we try and cover the most common
// use cases and fall back to `any`
type InputPlanForNamedType<TType extends GraphQLType> =
  TType extends GrafastInputObjectType<any, infer U, any>
    ? U
    : ModifierStep<any>;
type InputPlanForType<TType extends GraphQLInputType> =
  TType extends GraphQLNonNull<GraphQLList<GraphQLNonNull<infer U>>>
    ? InputPlanForNamedType<U>
    : TType extends GraphQLNonNull<GraphQLList<infer U>>
    ? InputPlanForNamedType<U>
    : TType extends GraphQLList<GraphQLNonNull<infer U>>
    ? InputPlanForNamedType<U>
    : TType extends GraphQLList<infer U>
    ? InputPlanForNamedType<U>
    : TType extends GraphQLNonNull<infer U>
    ? InputPlanForNamedType<U>
    : InputPlanForNamedType<TType>;

// TypeScript gets upset if we go too deep, so we try and cover the most common
// use cases and fall back to `any`
type InputTypeForNamedType<TType extends GraphQLType> =
  TType extends GraphQLScalarType<infer U> ? U : any;
type InputTypeFor<TType extends GraphQLInputType> =
  TType extends GraphQLNonNull<GraphQLList<GraphQLNonNull<infer U>>>
    ? InputTypeForNamedType<U>
    : TType extends GraphQLNonNull<GraphQLList<infer U>>
    ? InputTypeForNamedType<U>
    : TType extends GraphQLList<GraphQLNonNull<infer U>>
    ? InputTypeForNamedType<U>
    : TType extends GraphQLList<infer U>
    ? InputTypeForNamedType<U>
    : TType extends GraphQLNonNull<infer U>
    ? InputTypeForNamedType<U>
    : InputTypeForNamedType<TType>;

/*
type OutputPlanForType<TType extends GraphQLOutputType> =
  TType extends GraphQLList<
  infer U
>
  ? U extends GraphQLOutputType
    ? ListCapableStep<any, OutputPlanForType<U>>
    : never
  : TType extends GraphQLNonNull<infer V>
  ? V extends GraphQLOutputType
    ? OutputPlanForType<V>
    : never
  : TType extends GraphQLScalarType | GraphQLEnumType
  ? ExecutableStep<boolean | number | string>
  : ExecutableStep<{ [key: string]: any }>;

type InputPlanForType<TType extends GraphQLInputType> =
  TType extends GraphQLList<infer U>
    ? U extends GraphQLInputType
      ? InputPlanForType<U>
      : never
    : TType extends GraphQLNonNull<infer V>
    ? V extends GraphQLInputType
      ? InputPlanForType<V>
      : never
    : TType extends GraphQLScalarType | GraphQLEnumType
    ? null
    : ExecutableStep<{ [key: string]: any }> | null;

type InputTypeFor<TType extends GraphQLInputType> = TType extends GraphQLList<
  infer U
>
  ? U extends GraphQLInputType
    ? InputTypeFor<U>
    : never
  : TType extends GraphQLNonNull<infer V>
  ? V extends GraphQLInputType
    ? InputTypeFor<V>
    : never
  : TType extends GraphQLScalarType<infer U>
  ? U
  : any;
  */

/**
 * Basically GraphQLFieldConfig but with an easy to access `plan` method.
 */
export type GrafastFieldConfig<
  TType extends GraphQLOutputType,
  TContext extends Grafast.Context,
  TParentStep extends ExecutableStep | null,
  TFieldStep extends ExecutableStep, // TODO: should be OutputPlanForType<TType>, but that results in everything thinking it should be a ListStep
  TArgs extends BaseGraphQLArguments,
> = Omit<GraphQLFieldConfig<any, any>, "args" | "type"> & {
  type: TType;
  plan?: FieldPlanResolver<TArgs, TParentStep, TFieldStep>;
  subscribePlan?: FieldPlanResolver<TArgs, TParentStep, TFieldStep>;
  args?: GrafastFieldConfigArgumentMap<
    TType,
    TContext,
    TParentStep,
    TFieldStep
  >;
};

/**
 * Basically GraphQLFieldConfigArgumentMap but allowing for args to have plans.
 */
export type GrafastFieldConfigArgumentMap<
  _TType extends GraphQLOutputType,
  TContext extends Grafast.Context,
  TParentStep extends ExecutableStep | null,
  TFieldStep extends ExecutableStep, // TODO: should be OutputPlanForType<_TType>, but that results in everything thinking it should be a ListStep
> = {
  [argName: string]: GrafastArgumentConfig<
    any,
    TContext,
    TParentStep,
    TFieldStep,
    any,
    any
  >;
};

/**
 * Basically GraphQLArgumentConfig but allowing for a plan.
 */
export type GrafastArgumentConfig<
  TInputType extends GraphQLInputType = GraphQLInputType,
  _TContext extends Grafast.Context = Grafast.Context,
  _TParentStep extends ExecutableStep | null = ExecutableStep | null,
  TFieldStep extends ExecutableStep = ExecutableStep,
  _TArgumentStep extends TFieldStep extends ExecutableStep
    ? ModifierStep<TFieldStep> | null
    : null = TFieldStep extends ExecutableStep
    ? ModifierStep<TFieldStep> | null
    : null,
  _TInput extends InputTypeFor<TInputType> = InputTypeFor<TInputType>,
> = Omit<GraphQLArgumentConfig, "type"> & {
  type: TInputType;
  inputPlan?: ArgumentInputPlanResolver<any>;
  applyPlan?: ArgumentApplyPlanResolver<any, any>;
  autoApplyAfterParentPlan?: boolean;
  autoApplyAfterParentSubscribePlan?: boolean;
};

/**
 * Basically GraphQLInputFieldConfig but allowing for the field to have a plan.
 */
export type GrafastInputFieldConfig<
  TInputType extends GraphQLInputType,
  _TContext extends Grafast.Context,
  _TParentStep extends ModifierStep<any>,
  _TResultStep extends InputPlanForType<TInputType>,
  _TInput extends InputTypeFor<TInputType>,
> = Omit<GraphQLInputFieldConfig, "type"> & {
  type: TInputType;
  inputPlan?: InputObjectFieldInputPlanResolver;
  applyPlan?: InputObjectFieldApplyPlanResolver<any>;
  autoApplyAfterParentInputPlan?: boolean;
  autoApplyAfterParentApplyPlan?: boolean;
};

/**
 * The args passed to a field plan resolver, the values are plans.
 */
export type TrackedArguments<
  TArgs extends BaseGraphQLArguments = BaseGraphQLArguments,
> = {
  get<TKey extends keyof TArgs>(key: TKey): AnyInputStep;
};

/**
 * `@stream` directive meta.
 */
export interface StepStreamOptions {
  initialCount: number;
}
/**
 * Additional details about the planning for a field; currently only relates to
 * the `@stream` directive.
 */
export interface StepOptions {
  /**
   * Details for the `@stream` directive.
   */
  stream: StepStreamOptions | null;
}

/**
 * Options passed to the `optimize` method of a plan to give more context.
 */
export interface StepOptimizeOptions {
  stream: StepStreamOptions | null;
  meta: Record<string, unknown> | undefined;
}

/**
 * A subscriber provides realtime data, a SubscribeStep can subscribe to a
 * given topic (string) and will receive an AsyncIterableIterator with messages
 * published to that topic (standard pub/sub semantics).
 */
export type GrafastSubscriber<
  TTopics extends { [key: string]: any } = { [key: string]: any },
> = {
  subscribe<TTopic extends keyof TTopics = keyof TTopics>(
    topic: TTopic,
  ): PromiseOrDirect<AsyncIterableIterator<TTopics[TTopic]>>;
};

/**
 * Specifically relates to the stringification of NodeIDs, e.g. `["User", 1]`
 * to/from `WyJVc2VyIiwgMV0=`
 */
export interface NodeIdCodec<T = any> {
  name: string;
  encode(value: T): string | null;
  decode(value: string): T;
}

/**
 * Determines if a NodeID relates to a given object type, and also relates to
 * encoding the NodeID for that type.
 */
export type NodeIdHandler<
  TCodec extends NodeIdCodec<any> = NodeIdCodec<any>,
  TNodeStep extends ExecutableStep = ExecutableStep,
  TSpec = any,
> = {
  /**
   * The name of the object type this handler is for.
   */
  typeName: string;

  /**
   * Which codec are we using to encode/decode the NodeID string?
   */
  codec: TCodec;

  /**
   * Returns true if the given decoded Node ID value represents this type.
   */
  match(specifier: TCodec extends NodeIdCodec<infer U> ? U : any): boolean;

  /**
   * Returns a plan that returns the value ready to be encoded. When the result
   * of this plan is fed into `match`, it should return `true`.
   */
  plan(
    $thing: TNodeStep,
  ): ExecutableStep<TCodec extends NodeIdCodec<infer U> ? U : any>;

  /**
   * Returns a specification based on the Node ID, this can be in any format
   * you like. It is intended to then be fed into `get` or handled in your own
   * code as you see fit. (When used directly, it's primarily useful for
   * referencing a node without actually fetching it - e.g. allowing you to
   * delete a node by its ID without first fetching it.)
   */
  getSpec(
    plan: ExecutableStep<TCodec extends NodeIdCodec<infer U> ? U : any>,
  ): TSpec;

  /**
   * Combined with `getSpec`, this forms the recprocal of `plan`; i.e.
   * `get(getSpec( plan(node) ))` should return a plan that results in the
   * original node.
   */
  get(spec: TSpec): TNodeStep;

  deprecationReason?: string;
};

export type BaseEventMap = Record<string, any>;
export type EventMapKey<TEventMap extends BaseEventMap> = string &
  keyof TEventMap;
export type EventCallback<TPayload> = (params: TPayload) => void;

export interface TypedEventEmitter<TEventMap extends BaseEventMap>
  extends EventEmitter<any, any> {
  addListener<TEventName extends EventMapKey<TEventMap>>(
    eventName: TEventName,
    callback: EventCallback<TEventMap[TEventName]>,
  ): this;
  on<TEventName extends EventMapKey<TEventMap>>(
    eventName: TEventName,
    callback: EventCallback<TEventMap[TEventName]>,
  ): this;
  once<TEventName extends EventMapKey<TEventMap>>(
    eventName: TEventName,
    callback: EventCallback<TEventMap[TEventName]>,
  ): this;

  removeListener<TEventName extends EventMapKey<TEventMap>>(
    eventName: TEventName,
    callback: EventCallback<TEventMap[TEventName]>,
  ): this;
  off<TEventName extends EventMapKey<TEventMap>>(
    eventName: TEventName,
    callback: EventCallback<TEventMap[TEventName]>,
  ): this;

  emit<TEventName extends EventMapKey<TEventMap>>(
    eventName: TEventName,
    params: TEventMap[TEventName],
  ): boolean;
}

export type ExecutionEventMap = {
  /**
   * Something that can be added to the
   * ExecutionResult.extensions.explain.operations list.
   */
  explainOperation: {
    operation: Record<string, any> & { type: string; title: string };
  };
};

export type ExecutionEventEmitter = TypedEventEmitter<ExecutionEventMap>;

export interface ExecutionExtra {
  /** The `performance.now()` at which your step should stop executing */
  stopTime: number | null;
  /** If you have set a `metaKey` on your step, the relevant meta object which you can write into (e.g. for caching) */
  meta: Record<string, unknown> | undefined;
  eventEmitter: ExecutionEventEmitter | undefined;

  // These are only needed for subroutine plans, don't use them as we may
  // remove them later.
  /** @internal */
  _bucket: Bucket;
  /** @internal */
  _requestContext: RequestTools;
}

export interface LocationDetails {
  node: ASTNode | readonly ASTNode[];
  /** This should only be null for the root selection */
  parentTypeName: string | null;
  /** This should only be null for the root selection */
  fieldName: string | null;
}

export type JSONValue =
  | boolean
  | number
  | string
  | null
  | JSONObject
  | JSONArray;
export interface JSONObject {
  [key: string]: JSONValue;
}
export interface JSONArray extends Array<JSONValue> {}

export type UnwrapPlanTuple</* const */ TIn extends readonly ExecutableStep[]> =
  {
    [Index in keyof TIn]: TIn[Index] extends ExecutableStep<infer U>
      ? U
      : never;
  } & { length: number };

export type NotVariableValueNode = Exclude<ValueNode, VariableNode>;

export type StreamMaybeMoreableArray<T = any> = Array<T> & {
  [$$streamMore]?: AsyncIterator<any, any, any> | Iterator<any, any, any>;
};
export type StreamMoreableArray<T = any> = Array<T> & {
  [$$streamMore]: AsyncIterator<any, any, any> | Iterator<any, any, any>;
};

export interface GrafastArgs extends GraphQLArgs {
  resolvedPreset?: GraphileConfig.ResolvedPreset;
  requestContext?: Partial<Grafast.RequestContext>;
}

export interface GrafastPlanJSON {
  version: "v1" | "v2";
}

export interface GrafastPlanStepJSONv1 {
  id: string | number;
  stepClass: string;
  metaString: string | null;
  bucketId: string | number;
  dependencyIds: ReadonlyArray<string | number>;
  polymorphicPaths: readonly string[] | undefined;
  isSyncAndSafe: boolean | undefined;
  supportsUnbatched: boolean | undefined;
  hasSideEffects: boolean | undefined;
  extra?: Record<string, JSONValue | undefined>;
}

export interface GrafastPlanBucketPhaseJSONv1 {
  normalStepIds?: ReadonlyArray<string | number>;
  unbatchedStepIds?: ReadonlyArray<string | number>;
}

export type GrafastPlanBucketReasonJSONv1 =
  | GrafastPlanBucketReasonRootJSONv1
  | GrafastPlanBucketReasonNullableFieldJSONv1
  | GrafastPlanBucketReasonListItemJSONv1
  | GrafastPlanBucketReasonSubscriptionJSONv1
  | GrafastPlanBucketReasonMutationFieldJSONv1
  | GrafastPlanBucketReasonDeferJSONv1
  | GrafastPlanBucketReasonPolymorphicJSONv1
  | GrafastPlanBucketReasonSubroutineJSONv1;

export interface GrafastPlanBucketReasonRootJSONv1 {
  type: "root";
}
/** Non-branching, non-deferred */
export interface GrafastPlanBucketReasonNullableFieldJSONv1 {
  type: "nullableBoundary";
  parentStepId: string | number;
}
/** Non-branching, non-deferred */
export interface GrafastPlanBucketReasonListItemJSONv1 {
  type: "listItem";
  parentStepId: string | number;

  /** If this listItem is to be streamed, the configuration for that streaming */
  stream?: {
    initialCount: number;
    label?: string;
  };
}
/** Non-branching, deferred */
export interface GrafastPlanBucketReasonSubscriptionJSONv1 {
  type: "subscription";
}
/** Non-branching, deferred */
export interface GrafastPlanBucketReasonMutationFieldJSONv1 {
  type: "mutationField";
  mutationIndex: number;
}
/** Non-branching, deferred */
export interface GrafastPlanBucketReasonDeferJSONv1 {
  type: "defer";
  label?: string;
}
/** Branching, non-deferred */
export interface GrafastPlanBucketReasonPolymorphicJSONv1 {
  type: "polymorphic";
  typeNames: readonly string[];
  parentStepId: string | number;
  polymorphicPaths: ReadonlyArray<string>;
}
/** Non-branching, non-deferred */
export interface GrafastPlanBucketReasonSubroutineJSONv1 {
  type: "subroutine";
  parentStepId: string | number;
}

export interface GrafastPlanBucketJSONv1 {
  id: string | number;
  reason: GrafastPlanBucketReasonJSONv1;
  copyStepIds: ReadonlyArray<string | number>;
  steps: ReadonlyArray<GrafastPlanStepJSONv1>;
  rootStepId: string | number | null;
  phases: ReadonlyArray<GrafastPlanBucketPhaseJSONv1>;
  children: ReadonlyArray<GrafastPlanBucketJSONv1>;
}

export interface GrafastPlanJSONv1 extends GrafastPlanJSON {
  version: "v1";
  rootBucket: GrafastPlanBucketJSONv1;
}
