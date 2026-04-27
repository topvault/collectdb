<h1 align="center">collectdb</h1>

<p align="center">
    An open source, schema-first database for popular collectible types.
</p>

<p align="center">
    <a href="LICENSE">
        <img src="https://img.shields.io/badge/license-ODbL-blue.svg" alt="License: ODbL" />
    </a>
</p>

collectdb's goal is to provide a canonical, expressive, and stable catalog for collectibles such as trading cards, sports cards, and similar item-heavy domains where series structure, editions, product packaging, and variations matter.

Unlike flat card lists, collectdb models how collectibles are actually published and collected:

- collectible types contain generations
- generations contain series
- series can define editions
- series can catalog discrete items and sealed products
- series can define additional groups such as promos, test sets, or subsets
- items can link to variants and cross-series references
- every edition-specific item identity is represented by a stable, opaque identifier
- external cataloging systems can be connected through labeled integrations

This is the open source database that powers [TopVault](https://vault.top).
Adding to collectdb will make collectibles available for tracking in the TopVault app.

### View using Sheets

collectdb automatically sychronizes data to view-only sheets.
Please make copies of these templates if you would like to manage your own data.

<!-- google-sheets-links:start -->
- [Dragon Ball Cards](https://docs.google.com/spreadsheets/d/1peAlf56kChT4OUbtKQ2MbFpeCyELjaNqmLRWGTdd0Hw/edit)
- [MTG Cards](https://docs.google.com/spreadsheets/d/1YC2JOMRXd7N-c8A002c1JljG4hX4JSQ5CoVlxRKNfEo/edit)
- [Pokémon Cards](https://docs.google.com/spreadsheets/d/1ivDMhlcRWSiy9kPMLprjWX7-uSK-0CVOGWhDgc__FJk/edit)
<!-- google-sheets-links:end -->

## Why collectdb

Most collectible datasets handle the easy part well: a name, a number, and a set.

collectdb is built for the harder cases:

- multiple print editions of the same collectible
- product catalogs alongside the items they contain
- variants that belong to another base item
- subsets, promos, and special groups within a series
- stable identifiers that do not change when labels or metadata evolve
- explicit links to outside systems such as `priceCharting`, `tcgPlayer`, `scryfall`, and `pokeData`

The project is designed so that the schema is the contract. Data shape is not defined by convention or scattered scripts. It is defined and validated centrally.

## Repository Layout

The repository is organized around collectible type and a second directory level that represents language or region, depending on the dataset.

```text
data/
  pokemon-card/
    _type.yaml
    icon.webp
    english/
      _series.yaml
      base:base-set.yaml
      sv:151.yaml
  mtg-card/
    _type.yaml
    icon.webp
    english/
      _series.yaml
      mtg-1993:limited-edition-alpha.yaml
  sports-card/
    _type.yaml
    icon.webp
    english/
      _series.yaml
schema/
  Schema.ts
scripts/
  validate-data.ts
```

## Data Model

### Collectible Types

Each collectible type directory can define shared metadata in `_type.yaml`.

This file is used for the collectible type's display name, optional release date and description, and the friendly labels for the region directories it exposes.

```yaml
name: Pokemon Card
support: full
releaseDate: '1996-10-20'
description: Catalogs Pokemon trading cards and related collectible card releases across supported regions.
regions:
  english: English
  japanese: Japanese
```

`support` is required and currently accepts `full`, `in-progress`, or `none`.

Each collectible type directory is also expected to include an `icon.webp`.

### Generations

The `_series.yaml` file is the catalog of generations and series metadata.

Each generation groups related series together.

```yaml
base:
  name: Base Era
  series:
    base-set:
      name: Base Set
      releaseDate: '1999-01-09'
      region: international
      editions:
        unlimited: Unlimited
        1st-edition:
          name: 1st Edition
      integrations:
        priceCharting: pokemon-base-set
```

### Series

Each series file contains the catalog for one series.

Within a series you can define:

- `items`: the primary discrete collectibles
- `products`: sealed or packaged products that contain the items
- `additional`: special grouped catalogs such as promos, subsets, or test releases

```yaml
items:
  pikachu-58:
    name: Pikachu
    editions:
      unlimited: 7b61cc57-0ee8-4d6a-b77a-0a0d6da8afc8
      1st-edition: 5d15d96d-5fc2-44dc-8e47-8f4f7f5f52ff
    integrations:
      priceCharting: pikachu
      tcgPlayer: pikachu-base-set
    variant:
      name: Yellow Cheeks
    variants:
      red-cheeks:
        id: 69d4cfae-7e2d-45eb-9cf8-3d458d4aab5f
        name: Red Cheeks

products:
  booster-pack:
    name: Booster Pack
    editions:
      unlimited: c87e6553-395a-47d9-b2bd-36d93e6a76c3

additional:
  promos:
    name: Promos
    items:
      pikachu-promo:
        id: a0c44942-d03e-4a52-b1eb-2c2c34fdfc4a
        name: Pikachu Promo
```

### Editions, Groups, and Products

collectdb treats these as first-class concepts rather than optional notes:

- editions distinguish publication variants inside a series
- groups organize special item catalogs inside a series
- products describe packaged objects that contain or distribute items

This is particularly useful in domains like Pokemon, where a booster pack is a collectible product, but the cards inside it are the discrete items.

### Variants and References

collectdb specializes in cataloging variations.

An item can:

- define a display variant label
- define additional variants with their own opaque identifiers
- point at another base item through `variantOf`
- act as a reference to an item defined elsewhere through `referenceOf`

This allows the data model to express print, finish, packaging, and cross-series relationships without losing stable identity.

### Stable Opaque Identifiers

Every edition-specific item identity is represented by a stable, opaque identifier.

Those identifiers are intentionally not semantic. They are meant to remain stable even if:

- labels change
- descriptions improve
- integrations are remapped
- hierarchy or grouping becomes more precise

That makes collectdb suitable as a durable source of truth for downstream applications.

### Integrations

Integrations connect collectdb records to other cataloging systems through labeled keys.
These are best effort label-only documented linkages.

Examples currently modeled in the schema include:

- `priceCharting`
- `tcgPlayer`
- `scryfall`
- `pokeData`

Integrations can be attached at the series, item, variant, or group level depending on what is being mapped.

## Schema and Validation

The schema is the ground truth for how collectdb data is formed.

- runtime schema: [schema/Schema.ts](schema/Schema.ts)
- validator: [scripts/validate-data.ts](scripts/validate-data.ts)

To validate the repository data:

```sh
npm install
npm run validate:data
```

To validate a narrower subtree:

```sh
npm run validate:data -- data/pokemon-card/english
```

The validator walks the data tree, parses YAML, and checks:

- `_type.yaml` files against the collectible type schema
- each collectible type directory for a required `icon.webp`
- `_series.yaml` files against the generation map schema
- series files against the series items schema

## Formatting

The repository includes a root `.editorconfig` so common editors use the same basic whitespace and line-ending rules.

YAML formatting is normalized with Prettier and can be applied or checked with:

```sh
npm run format
npm run format:check
```

The GitHub Actions workflow runs `npm run format:check` on pull requests and pushes to `main`.

## Maintenance Scripts

collectdb also includes data-specific maintenance scripts for ID assignment, explicit index creation, and reference normalization.

To assign missing opaque IDs for items, products, additional items, and variants:

```sh
npm run snag -- pokemon-card english
```

To add missing explicit `index` values for records whose item key ends with a numeric suffix:

```sh
npm run index -- pokemon-card english
```

To check that all expected explicit indexes are present and match the item-key suffix without writing changes:

```sh
npm run index -- --check
```

To normalize `referenceOf` and `variantOf` objects from shorthand IDs or partial objects:

```sh
npm run reference-of -- pokemon-card english
```

To create or update the public Google Sheets mirrors:

```sh
npm run sheets-sync -- --create-missing
```

This command creates one spreadsheet per collectible type, keeps one tab per language or region, and writes the tracked spreadsheet IDs to `.sheets.yaml`.

The GitHub Actions workflow runs the same sync after successful pushes to `main`, updates the spreadsheet content, and commits refreshed README links or newly created spreadsheet IDs when needed.

## Design Principles

- schema-first: the schema defines the contract
- expressive hierarchy: generations, series, editions, groups, and products all matter
- stable identity: item identifiers should survive metadata changes
- variation-aware: variants and references are part of the model, not edge cases
- integration-friendly: external cataloging systems can be attached explicitly
- human-editable: YAML remains practical to read, review, and contribute to

## Collaboration

You can help collectdb by opening an issue or a pull request.

- suggest a missing item or variant through the [missing item form](https://github.com/topvault/collectdb/issues/new?template=missing-collectible.yml)
- suggest a new collectible type through the [new collectible type form](https://github.com/topvault/collectdb/issues/new?template=new-collectible-type.yml)
- open a pull request directly when you already know the data changes to make

Contributions are especially useful in these areas:

- adding new collectible types
- expanding existing series coverage
- improving variant and product catalogs
- tightening schema rules and validation
- documenting edge cases and modeling decisions

Before opening a pull request, run:

```sh
npm run pr:prepare
```

This formats YAML, fills missing opaque IDs, adds missing explicit indexes, normalizes `referenceOf` and `variantOf` links, and runs schema validation.

If you want to run the same command sequence used for pull request checks without writing changes, run:

```sh
npm run pr:check
```

When contributing data:

1. update the relevant files under [data](data)
2. run `npm run pr:prepare`
3. make sure new records preserve stable opaque identifiers where applicable

## Status

collectdb is intended to become a long-lived canonical database for collectible domains where structure and variation matter as much as names and numbers.

If you are building tools for pricing, collection tracking, checklisting, grading, or catalog exploration, collectdb is designed to be a dependable source of structured identity and hierarchy.

## Disclaimer

The names of collectible types and their content are the copyright of their respective copyright holders.

TopVault and collectdb are not produced by, endorsed by, supported by, or affiliated with The Pokemon Company, Pokemon, Nintendo, Game Freak, or Wizards of the Coast.
