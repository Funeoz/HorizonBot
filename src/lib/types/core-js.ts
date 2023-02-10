/* eslint-disable @typescript-eslint/no-explicit-any */

export {};

type Resolver<T> = (item: T) => unknown;
type Indexer<T> = number | symbol | keyof T;
type ValueResolver<T> = Indexer<T> | Resolver<T>;

declare global {
  // Define the core-js "Array#uniqueBy" polyfill
  interface Array<T> {
    uniqueBy(valueResolver?: ValueResolver<T>): T[];
  }

  // Define the new core-js collection-methods polyfill
  interface Set<T> {
    addAll(...values: T[]): this;
    deleteAll(...values: T[]): this;
    every<S extends T>(predicate: (value: T, _: T, set: Set<T>) => value is S, thisArg?: any): this is Set<S>;
    every(predicate: (value: T, _: T, set: Set<T>) => unknown, thisArg?: any): boolean;
    filter<S extends T>(predicate: (value: T, _: T, set: Set<T>) => value is S, thisArg?: any): Set<S>;
    filter(predicate: (value: T, _: T, set: Set<T>) => unknown, thisArg?: any): Set<T>;
    find<S extends T>(predicate: (this: void, value: T, _: T, set: Set<T>) => value is S, thisArg?: any): S | undefined;
    find(predicate: (value: T, _: T, set: Set<T>) => unknown, thisArg?: any): T | undefined;
    join(separator?: string): string;
    map<U>(callbackfn: (value: T, _: T, set: Set<T>) => U, thisArg?: any): Set<U>;
    reduce(callbackfn: (previousValue: T, currentValue: T, _: T, set: Set<T>) => T, initialValue: T): T;
    reduce(callbackfn: (previousValue: T, currentValue: T, _: T, set: Set<T>) => T): T;
    reduce<U>(callbackfn: (previousValue: U, currentValue: T, _: T, set: Set<T>) => U, initialValue: U): U;
    some(predicate: (value: T, _: T, set: Set<T>) => unknown, thisArg?: any): boolean;
  }

  // Define the new core-js map-upsert polyfill
  interface Map<K, V> {
    emplace(key: K, handlers: {
      insert?(key: K, map: Map<K, V>): V;
      update?(existing: V, key: K, map: Map<K, V>): V;
    }): V;
  }
}
