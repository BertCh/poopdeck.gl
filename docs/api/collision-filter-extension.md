# CollisionFilterExtension

The `CollisionFilterExtension` hides colliding instances — overlapping icons or text labels — so a crowded layer de-clutters itself, keeping the higher-priority instance where two overlap. It is a poopdeck-native port of deck.gl's `CollisionFilterExtension`: the class is re-exported unchanged, and a `collisionFilterProps` helper makes the one-import ergonomic and spells out the constant configuration that already works on binary STT tiles.

deck's **constant** configuration (`collisionEnabled` / `collisionGroup` / `collisionTestProps`) works on the STT layers today through the plain top-level `extensions` prop — the composite layer forwards those scalars onto every binary sublayer, the same passthrough used for Brushing / Mask / Clip. `collisionFilterProps` bundles the extension and those props into one spreadable object.

## Installation

```typescript
import {
  CollisionFilterExtension,
  collisionFilterProps,
  COLLISION_PRIORITY_MIN,
  COLLISION_PRIORITY_MAX,
} from '@poopdeck.gl/layers';
```

## Usage

Spread `collisionFilterProps(...)` onto any STT layer. It merges the extension into any `extensions` you already pass and wires the constant collision props:

```typescript
import { AnimatedIconLayer, collisionFilterProps } from '@poopdeck.gl/layers';

new AnimatedIconLayer({
  // …tileset / icon props…
  ...collisionFilterProps({ collisionEnabled: true, collisionGroup: 'labels' }),
});
```

The constant case can equivalently be written with the extension directly:

```typescript
new AnimatedIconLayer({
  // …tileset / icon props…
  extensions: [new CollisionFilterExtension()],
  collisionEnabled: true,
  collisionGroup: 'labels',
});
```

## Options

`collisionFilterProps(options: CollisionFilterOptions)` accepts:

| Property                    | Type                      | Default            | Description                                                                                                                                                                                                                                                   |
| :-------------------------- | :------------------------ | :----------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `collisionEnabled`          | `boolean`                 | `true`             | Enable/disable collisions. When disabled every object renders.                                                                                                                                                                                                |
| `collisionGroup`            | `string`                  | deck's `'default'` | Collision group this layer belongs to. Layers in different groups never collide with each other. Omit to fall back to deck's `'default'` group.                                                                                                               |
| `collisionTestProps`        | `Record<string, unknown>` | —                  | Props overridden while deck renders the (hidden) collision map — e.g. `{ radiusScale: 2 }` to reserve extra space around each icon.                                                                                                                           |
| `collisionPriority`         | `number`                  | —                  | CONSTANT collision priority in `[-1000, 1000]`; higher wins. Applies to every feature in the layer (rank a whole layer above/below another). Out-of-range values are clamped with a one-time warning. Omit to leave deck's own default in force.              |
| `getCollisionPriority`      | `Accessor<DataT, number>` | —                  | Upstream-shaped priority accessor, passed through to deck unchanged. Use it when you are composing with non-binary data; on a binary STT tile there are no JS rows for it to run over. Supplying this AND `collisionPriority` warns once — the accessor wins. |
| `collisionPriorityProperty` | `string`                  | —                  | **Deferred** — a baked tile column name for per-feature priority. Not wired in the layers yet. Passing it warns once and falls back to the constant `collisionPriority`. See [Behavior](#behavior).                                                           |
| `extensions`                | `LayerExtension[]`        | `[]`               | Existing extensions to compose with. A `CollisionFilterExtension` already present is reused (not duplicated); everything else is preserved.                                                                                                                   |

## Returned props

`collisionFilterProps` returns a `CollisionFilterProps` object, spreadable onto any STT layer:

| Property               | Type                      | Description                                                                                                                                                                                                                                                                                                                                          |
| :--------------------- | :------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions`           | `LayerExtension[]`        | The merged extension list, including a `CollisionFilterExtension`.                                                                                                                                                                                                                                                                                   |
| `collisionEnabled`     | `boolean`                 | The resolved `collisionEnabled` value.                                                                                                                                                                                                                                                                                                               |
| `collisionGroup`       | `string`                  | Present only when `collisionGroup` was supplied.                                                                                                                                                                                                                                                                                                     |
| `collisionTestProps`   | `Record<string, unknown>` | Present only when `collisionTestProps` was supplied.                                                                                                                                                                                                                                                                                                 |
| `getCollisionPriority` | `Accessor<DataT, number>` | **Present only when a priority was requested** — via `collisionPriority` (emitted as a constant, clamped to `[COLLISION_PRIORITY_MIN, COLLISION_PRIORITY_MAX]`) or via `getCollisionPriority` (passed through verbatim). Omitted otherwise, so deck's own default applies and a priority accessor you set directly on the layer survives the spread. |

## Priority constants

| Constant                 | Value   | Description                                      |
| :----------------------- | :------ | :----------------------------------------------- |
| `COLLISION_PRIORITY_MIN` | `-1000` | Lower bound of deck's documented priority clamp. |
| `COLLISION_PRIORITY_MAX` | `1000`  | Upper bound of deck's documented priority clamp. |

Priorities outside `[-1000, 1000]` are meaningless to deck; `collisionFilterProps` clamps them into range and emits a one-time console warning.

## Behavior

- **Constant configuration works today.** `collisionEnabled`, `collisionGroup`, and `collisionTestProps` are forwarded verbatim from the composite layer onto every binary sublayer, so de-cluttering icons and labels needs no layer-level change.
- **A constant `collisionPriority` works.** Ranking a whole layer above or below another group is forwarded as the constant `getCollisionPriority` prop. The value is clamped to `[COLLISION_PRIORITY_MIN, COLLISION_PRIORITY_MAX]`.
- **A shared extension instance keeps the shader cache warm.** When no `CollisionFilterExtension` is present in the passed `extensions`, a single shared instance is appended; a caller-supplied instance is reused rather than duplicated, keeping the extension set stable.
- **Data-driven priority is deferred.** deck ranks colliding features by `getCollisionPriority`, an accessor. On a binary tile there are no JS rows to run an accessor over, so a per-feature priority would have to arrive as a baked `collisionPriorities` instanced attribute — a layer-level change the STT layers do not emit yet. Passing `collisionPriorityProperty` therefore warns once and falls back to the constant `collisionPriority`, meaning every feature ranks equally.

## Source

[packages/layers/src/extensions/collision-filter-extension.ts](../../packages/layers/src/extensions/collision-filter-extension.ts)
