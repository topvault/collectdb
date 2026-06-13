import { z } from 'zod';

// RarityScore is a collectdb-specific rating system intended to be agnostic of collectible type rarities.
// This rarity scoring factors in both the known/assumed population as well as market price.
type RarityScore =
    | 0 // No score so the modifier is 0.
    | 1 // Rated a common, price < 10c
    | 2 // Rated uncommon, price < $1
    | 3 // Rated rare, price < $10
    | 4 // Rated rare, price < $100
    | 5 // Rated rare, price < $250
    | 6 // Rated rare, price < $1000
    | 7 // Usually extremely rare variant, price < $10,000, usually < 10,000 total population
    | 8 // Test, employee-only, variant, price < $100,000, usually < 1000 total population
    | 9 // price $100-250k, usually < 100 population
    | 10 // prices > 250k, or priceless, usually less than 10 population
    | 11; // prices > 1M, or priceless, usually one of a kind

// An authenticator match is a common string on authenticator labels that indicates the series.
type AuthenticatorMatchSet = string[] | string[][];
type ItemAuthenticators = Record<string, AuthenticatorMatchSet>;

// A Series Edition is a well-known variation of the collectible for a known "edition".
// Editions tend to occur in sequence, and the default edition placeholder is "unlimited", or "Normal".
const SeriesEditionSchema = z.object({
    name: z.string(),
    releaseDate: z.union([z.string(), z.date()]).optional(),
    description: z.string().optional(),
    links: z.record(z.string(), z.string()).optional(),
});

// Single or per-edition refers to labeling an entire item or labeling each edition individually.
const SingleOrPerEdition = z.union([z.string(), z.record(z.string(), z.string())]);
const RarityScoreSchema = z.number().min(0).max(11);

// A Generation is a group of series within a collectible type.
// The series "keys" must be listed explicitly.
// These keys map to file names that will be read in the form "<generation-key>:<series-key>.yaml".
export const GenerationSchema = z
    .object({
        name: z.string(),
        description: z.string().optional(),
        links: z.record(z.string(), z.string()).optional(),
        series: z.array(z.string()).optional(),
    })
    .strict();

// A region or language within a collectible type is made up of one or more generations.
// For collectible types that have no explicit generation then "base" may be used.
export const RegionSchema = z.object({
    name: z.string().min(3),
    description: z.string().optional(),
    links: z.record(z.string(), z.string()).optional(),
    generations: z.record(z.string(), GenerationSchema).optional(),
});

export const RemarkSchema = z
    .object({
        name: z.string().min(3),
        editions: z.array(z.string()).optional(),
        description: z.string().optional(),
    })
    .strict();

// A collectible type is the top-level category for collectibles.
// It is made up of one or more regions (or languages) and they must be explicitly listed.
// Each region maps to a directory containing a valid RegionSchema defined in _region.yaml.
export const CollectibleTypeSchema = z
    .object({
        name: z.string().min(3),
        support: z.enum(['full', 'in-progress', 'none']),
        releaseDate: z.union([z.string(), z.date()]).optional(),
        description: z.string().optional(),
        regions: z.array(z.string()).min(1),

        // The remarks this collectible type recognizes: each remark slug mapped to a
        // friendly name and description. The data validator asserts every remark used
        // by an item or variant in this type is declared here. See RemarkSchema below.
        remarks: z.record(z.string(), RemarkSchema).optional(),
    })
    .strict();

const VariantDescriptor = z.object({
    name: z.string(),
    description: z.string().optional(),
    links: z.record(z.string(), z.string()).optional(),
    edition: z.string().optional(), // If the variant is limited to a specific edition.
});

const ScalarIntegrationsSchema = z
    .object({
        // General multi-collection-type databases.
        priceCharting: z.union([z.string(), z.number()]).optional(),
        tcgPlayer: z.string().optional(),
        pokeData: z.string().optional(),
        // Pokemon-card specific databases.
        tcgCollector: z.string().optional(),
        // MtG-card specific databases.
        scryfall: z.string().optional(),
        // Hot Wheels specific databases.
        hwcn: z.string().optional(),
        hdbid: z.string().optional(),
    })
    .strict();

const SingleOrPerEditionIntegrationsSchema = z
    .object({
        priceCharting: SingleOrPerEdition.optional(),
        tcgCollector: SingleOrPerEdition.optional(),
        tcgPlayer: SingleOrPerEdition.optional(),
        scryfall: SingleOrPerEdition.optional(),
        pokeData: SingleOrPerEdition.optional(),
        hwcn: SingleOrPerEdition.optional(),
        hdbid: SingleOrPerEdition.optional(),
    })
    .strict();

const VariantSchema = VariantDescriptor.extend({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    index: z.union([z.string(), z.number()]).optional(),
    links: z.record(z.string(), z.string()).optional(),
    remark: z.string().optional(), // A remark 'slug' defined by the collectible type.
    // Edge case to consider, an edition should not be named "products" or "additional".
    // For "short hand" an edition can be a name of the editionId to name.
    authenticators: z
        .unknown()
        .transform(val => val as ItemAuthenticators)
        .optional(), // ItemAuthenticatorsType
    photos: z.array(z.string()).optional(), // Names of the images, expect a corresponding webp file ("front" is always checked).
    integrations: ScalarIntegrationsSchema.optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    // This overrides the rarity score for the variant.
    // It is a common case that the base item has a static rarity and the variant is much rarer.
    // The rarity of the variant does not have a different static indicator, but we directly set the score.
    rarityScore: RarityScoreSchema.transform(val => val as RarityScore).optional(),
}).strict();

// A Reference Of is a mapping to another item.
// There is a short-hand version only requiring an item key and ID when referencing another item in the same series.
// If the item is in another series then the correct metadata must be repeated in the reference of for that ID.
const ReferenceOfSchema = z
    .object({
        id: z.string(),
        item: z.string(),
        edition: z.string().optional(), // Must be filled if not using a group.
        variant: z.string().optional(),
        group: z.string().optional(),
        // If the item belongs to another series.
        generation: z.string().optional(),
        series: z.string().optional(),
    })
    .strict();

const ReferenceItemSchema = z
    .object({
        // A "referenceOf" item is not entered into the database.
        // It is applied to a series for reference, to facilitate browsing the series.
        referenceOf: ReferenceOfSchema,
        edition: z.string().optional(),
    })
    .strict();

const DiscreteItemSchema = z
    .object({
        name: z.string(),
        // An edition-key (set in the series) mapped to an item id.
        // Before snag runs, an edition may temporarily use an empty string placeholder.
        editions: z.record(z.string(), z.string()),
        description: z.string().optional(),
        index: z.union([z.string(), z.number()]).optional(),
        links: z.record(z.string(), z.string()).optional(),
        releaseDate: z.union([z.string(), z.date()]).optional(), // Usually applied to products.
        authenticators: z
            .unknown()
            .transform(val => val as ItemAuthenticators)
            .optional(), // ItemAuthenticators type
        photos: z.array(z.string()).optional(), // Names of the images, expect a corresponding webp file ("front" is always checked).
        // Allow integrations to be set per-edition.
        integrations: SingleOrPerEditionIntegrationsSchema.optional(),
        // If not provided then the details:rarity static value is used.
        // If there is no rarity found then a default low value is used.
        rarityScore: RarityScoreSchema.transform(val => val as RarityScore).optional(),
        variant: VariantDescriptor.optional(), // If this item should have a variant-label.
        remark: z.string().optional(), // A remark 'slug' defined by the collectible type.
        variantOf: ReferenceOfSchema.optional(), // If this item is a variant of another item.
        variants: z.record(z.string(), VariantSchema).optional(), // Define additional variants.
        details: z.record(z.string(), z.unknown()).optional(),
        banned: z.boolean().optional(),
    })
    .strict();

// The item schema is a union of either a reference or discrete item.
// This allows for type enforcement that a reference item can only contain referenceOf.
const ItemSchema = DiscreteItemSchema.or(ReferenceItemSchema);

const AdditionalItemSchema = DiscreteItemSchema.omit({ editions: true, integrations: true })
    .extend({
        id: z.string(),
        // This is the item ID for the base item.
        // If this is defined then the base item's key data will be used as details/defaults.
        variantOf: z.string().or(ReferenceOfSchema).optional(),
        // Since there are no editions, expect only a value-integration for the item, not per-edition.
        integrations: ScalarIntegrationsSchema.optional(),
    })
    .strict();

const ItemKey = z.string();

const ItemMapSchema = z.record(ItemKey, ItemSchema);
const AdditionalItemMapSchema = z.record(ItemKey, ReferenceItemSchema.or(AdditionalItemSchema));

// Additional categories of items, to organize them into edition-like groups within a series.
// This can be used for test sets, pre-release sets, etc.
// Promos can be included here, but if there is a single promo then it can be included in the items list.
const AdditionalGroupSchema = z
    .object({
        name: z.string(),
        // The description is for record-keeping, this is not transferred into the database yet.
        // It could be appended to the description for the series, sort of bullet-pointed details about the
        // additional groups of items in the series.
        description: z.string().optional(),
        links: z.record(z.string(), z.string()).optional(),
        releaseDate: z.union([z.string(), z.date()]).optional(),
        integrations: ScalarIntegrationsSchema.optional(),
        rarityScore: RarityScoreSchema.transform(val => val as RarityScore).optional(),
        items: AdditionalItemMapSchema,
    })
    .strict();

export const SeriesSchema = z
    .object({
        name: z.string(),
        editions: z.record(z.string(), z.union([SeriesEditionSchema, z.string()])).optional(),
        integrations: SingleOrPerEditionIntegrationsSchema.or(z.null()).optional(),
        authenticators: z.unknown().optional(), // SeriesAuthenticators type.
        releaseDate: z.union([z.string(), z.date()]),
        region: z.string().optional(),
        description: z.string().optional(),
        links: z.record(z.string(), z.string()).optional(),

        // A series may add specific remarks.
        remarks: z.record(z.string(), RemarkSchema).optional(),

        items: ItemMapSchema,
        products: ItemMapSchema.optional(),
        additional: z.record(z.string(), AdditionalGroupSchema).optional(),
    })
    .strict();

// The _region.yaml file.
export type RegionDescriptor = z.infer<typeof RegionSchema>;
// Each <generation>:<series>.yaml file.
export type SeriesDescriptor = z.infer<typeof SeriesSchema>;
// A _type.yaml file for a collectible type.
export type CollectibleType = z.infer<typeof CollectibleTypeSchema>;


export type Generation = z.infer<typeof GenerationSchema>;
export type Variant = z.infer<typeof VariantSchema>;
export type DiscreteItem = z.infer<typeof DiscreteItemSchema>;
export type ReferenceItem = z.infer<typeof ReferenceItemSchema>;
export type AdditionalItem = z.infer<typeof AdditionalItemSchema>;
export type AdditionalGroup = z.infer<typeof AdditionalGroupSchema>;
export type ReferenceOf = z.infer<typeof ReferenceOfSchema>;
export type SingleOrPerEdition = z.infer<typeof SingleOrPerEdition>;
