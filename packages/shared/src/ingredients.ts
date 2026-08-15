/**
 * THE INGREDIENT TAXONOMY.
 *
 * This is the equipment lesson, applied to the hard case.
 *
 * `EQUIPMENT` is a closed enum, so checking it is exact set membership and the
 * check is trivially correct. Ingredients were free text, so checking them meant
 * string matching — and string matching produced two confident false positives
 * on the first eval run:
 *
 *   1. "tinned tomatoes" normalised to "tinned tomatoe", so a recipe's "tinned
 *      tomato" didn't match a pantry that literally contained it.
 *   2. "coconut milk" contains the substring "milk", so it failed a dairy-free
 *      check despite being dairy-free.
 *
 * Neither is fixable by adding another string rule. They're fixable by giving
 * ingredients identities and attributes, so the questions become lookups:
 *
 *   "is this in the pantry?"   → canonical id equality
 *   "is this dairy?"           → attribute lookup
 *
 * No morphology, no substrings, no compound-noun ambiguity.
 *
 * COVERAGE IS DELIBERATELY PARTIAL. This is a starter set, not an ontology. The
 * resolver falls back to lexical matching for anything not listed here, so the
 * taxonomy improves precision where it has coverage and changes nothing where it
 * doesn't. Unmapped terms are logged, and that queue is what grows this file —
 * seeding from USDA FoodData Central becomes worthwhile once the queue says so.
 */

export interface IngredientAttrs {
  /** Milk, butter, cheese, cream, yoghurt. NOT plant milks. */
  dairy?: boolean;
  /** Land animal flesh, and stocks made from it. */
  meat?: boolean;
  /** Fish, shellfish, and the sauces built on them. */
  fish?: boolean;
  /** Contains wheat/barley/rye gluten. */
  gluten?: boolean;
  /** Animal-derived but not flesh or dairy: eggs, honey, gelatin. */
  animal?: boolean;
}

export interface IngredientEntry {
  id: string;
  display: string;
  /** Written in singular; the resolver lemmatises before comparing. */
  synonyms: string[];
  attrs: IngredientAttrs;
}

const e = (
  id: string,
  display: string,
  synonyms: string[],
  attrs: IngredientAttrs = {},
): IngredientEntry => ({ id, display, synonyms, attrs });

export const INGREDIENTS: IngredientEntry[] = [
  // ── Dairy ────────────────────────────────────────────────────────────────
  e("milk", "milk", ["dairy milk", "whole milk", "full fat milk", "semi skimmed milk", "skimmed milk"], { dairy: true }),
  e("butter", "butter", ["unsalted butter", "salted butter"], { dairy: true }),
  e("cheese", "cheese", ["cheddar", "grated cheese"], { dairy: true }),
  e("parmesan", "parmesan", ["parmigiano", "parmigiano reggiano", "parmesan cheese", "pecorino"], { dairy: true }),
  e("mozzarella", "mozzarella", ["mozzarella cheese", "buffalo mozzarella"], { dairy: true }),
  e("feta", "feta", ["feta cheese"], { dairy: true }),
  e("cream", "cream", ["double cream", "single cream", "heavy cream", "sour cream", "creme fraiche"], { dairy: true }),
  e("yoghurt", "yoghurt", ["yogurt", "greek yoghurt", "greek yogurt", "natural yoghurt"], { dairy: true }),

  // ── Plant milks — the exact case that broke ──────────────────────────────
  e("coconut_milk", "coconut milk", ["tinned coconut milk", "canned coconut milk", "coconut cream"], {}),
  e("almond_milk", "almond milk", [], {}),
  e("oat_milk", "oat milk", [], { gluten: true }),
  e("soy_milk", "soy milk", ["soya milk"], {}),

  // ── Meat ─────────────────────────────────────────────────────────────────
  e("chicken", "chicken", ["chicken breast", "chicken thigh", "chicken leg", "roast chicken"], { meat: true }),
  e("beef", "beef", ["steak", "beef steak", "sirloin", "rib eye", "beef mince", "minced beef", "beef shin", "brisket"], { meat: true }),
  e("pork", "pork", ["pork chop", "pork belly", "pork shoulder"], { meat: true }),
  e("lamb", "lamb", ["lamb chop", "lamb shoulder", "lamb mince"], { meat: true }),
  e("bacon", "bacon", ["streaky bacon", "back bacon", "pancetta"], { meat: true }),
  e("ham", "ham", ["prosciutto", "gammon"], { meat: true }),
  e("sausage", "sausage", ["pork sausage", "chorizo"], { meat: true }),
  e("duck", "duck", ["duck breast", "duck leg"], { meat: true }),
  e("chicken_stock", "chicken stock", ["chicken broth", "chicken bouillon"], { meat: true }),
  e("beef_stock", "beef stock", ["beef broth"], { meat: true }),

  // ── Fish and shellfish ───────────────────────────────────────────────────
  e("fish", "fish", ["white fish", "cod", "haddock", "sea bass"], { fish: true }),
  e("salmon", "salmon", ["salmon fillet", "smoked salmon"], { fish: true }),
  e("tuna", "tuna", ["tinned tuna", "tuna steak"], { fish: true }),
  e("prawn", "prawn", ["shrimp", "king prawn"], { fish: true }),
  e("anchovy", "anchovy", ["anchovy fillet"], { fish: true }),
  e("fish_sauce", "fish sauce", ["nam pla"], { fish: true }),
  e("oyster_sauce", "oyster sauce", [], { fish: true }),
  e("worcestershire", "worcestershire sauce", [], { fish: true }),
  e("fish_stock", "fish stock", [], { fish: true }),

  // ── Other animal-derived ─────────────────────────────────────────────────
  e("egg", "egg", ["free range egg", "egg white", "egg yolk"], { animal: true }),
  e("honey", "honey", ["runny honey"], { animal: true }),
  e("gelatin", "gelatin", ["gelatine"], { animal: true }),

  // ── Gluten-bearing ───────────────────────────────────────────────────────
  e("flour", "plain flour", ["all purpose flour", "white flour", "wheat flour", "bread flour", "self raising flour"], { gluten: true }),
  e("pasta", "pasta", ["spaghetti", "penne", "linguine", "tagliatelle", "macaroni", "fusilli"], { gluten: true }),
  e("bread", "bread", ["sourdough", "baguette", "pita", "pitta", "flatbread", "naan"], { gluten: true }),
  e("noodles_egg", "egg noodle", ["yellow noodle", "wheat noodle", "ramen noodle"], { gluten: true, animal: true }),
  e("couscous", "couscous", [], { gluten: true }),
  e("barley", "barley", ["pearl barley"], { gluten: true }),
  e("breadcrumb", "breadcrumb", ["panko"], { gluten: true }),
  e("soy_sauce", "soy sauce", ["light soy sauce", "dark soy sauce", "shoyu"], { gluten: true }),

  // ── Gluten-free staples that look similar ────────────────────────────────
  e("rice", "rice", ["white rice", "brown rice", "basmati rice", "jasmine rice", "long grain rice"], {}),
  e("rice_noodles", "rice noodle", ["vermicelli", "flat rice noodle"], {}),
  e("cornflour", "cornflour", ["cornstarch", "corn flour"], {}),
  e("tamari", "tamari", [], {}),
  e("polenta", "polenta", ["cornmeal"], {}),
  e("quinoa", "quinoa", [], {}),
  e("oats", "oat", ["rolled oat", "porridge oat"], { gluten: true }),

  // ── Legumes and pulses ───────────────────────────────────────────────────
  e("red_lentils", "red lentil", ["split red lentil"], {}),
  e("lentils", "lentil", ["green lentil", "brown lentil", "puy lentil"], {}),
  e("chickpea", "chickpea", ["tinned chickpea", "garbanzo bean"], {}),
  e("kidney_bean", "kidney bean", ["red kidney bean"], {}),
  e("white_bean", "white bean", ["cannellini bean", "butter bean", "haricot bean"], {}),
  e("black_bean", "black bean", [], {}),
  e("peas", "pea", ["frozen pea", "garden pea"], {}),
  e("tofu", "tofu", ["firm tofu", "silken tofu"], {}),

  // ── Vegetables ───────────────────────────────────────────────────────────
  e("onion", "onion", ["brown onion", "white onion", "yellow onion"], {}),
  e("red_onion", "red onion", [], {}),
  e("spring_onion", "spring onion", ["scallion", "green onion"], {}),
  e("shallot", "shallot", [], {}),
  e("garlic", "garlic", ["garlic clove"], {}),
  e("ginger", "ginger", ["fresh ginger", "root ginger"], {}),
  e("tomato", "tomato", ["cherry tomato", "plum tomato", "vine tomato"], {}),
  e("tomato_tinned", "tinned tomato", ["canned tomato", "chopped tomato", "plum tomato tin", "passata"], {}),
  e("tomato_puree", "tomato puree", ["tomato paste"], {}),
  e("potato", "potato", ["new potato", "baby potato", "maris piper"], {}),
  e("sweet_potato", "sweet potato", ["yam"], {}),
  e("carrot", "carrot", ["baby carrot"], {}),
  e("celery", "celery", ["celery stick"], {}),
  e("cabbage", "cabbage", ["white cabbage", "savoy cabbage", "red cabbage"], {}),
  e("pak_choi", "pak choi", ["bok choy", "pak choy"], {}),
  e("spinach", "spinach", ["frozen spinach", "baby spinach"], {}),
  e("broccoli", "broccoli", ["tenderstem broccoli"], {}),
  e("green_beans", "green bean", ["french bean", "runner bean"], {}),
  e("courgette", "courgette", ["zucchini"], {}),
  e("aubergine", "aubergine", ["eggplant"], {}),
  e("pepper_bell", "bell pepper", ["red pepper", "capsicum", "green pepper"], {}),
  e("mushroom", "mushroom", ["chestnut mushroom", "button mushroom", "portobello"], {}),
  e("cucumber", "cucumber", [], {}),
  e("lettuce", "lettuce", ["gem lettuce", "romaine"], {}),
  e("leek", "leek", [], {}),
  e("cauliflower", "cauliflower", [], {}),
  e("corn", "sweetcorn", ["corn", "tinned sweetcorn"], {}),
  e("pumpkin", "pumpkin", ["squash", "butternut squash"], {}),

  // ── Fruit ────────────────────────────────────────────────────────────────
  e("lemon", "lemon", ["lemon juice", "lemon zest"], {}),
  e("lime", "lime", ["lime juice", "lime zest"], {}),
  e("apple", "apple", [], {}),
  e("banana", "banana", [], {}),
  e("avocado", "avocado", [], {}),
  e("coconut", "coconut", ["desiccated coconut"], {}),

  // ── Herbs, spices, aromatics ─────────────────────────────────────────────
  e("coriander", "coriander", ["cilantro", "fresh coriander"], {}),
  e("parsley", "parsley", ["flat leaf parsley"], {}),
  e("basil", "basil", ["fresh basil"], {}),
  e("mint", "mint", ["fresh mint"], {}),
  e("thyme", "thyme", ["fresh thyme"], {}),
  e("rosemary", "rosemary", [], {}),
  e("chilli", "chilli", ["chili", "red chilli", "chilli flake", "chile"], {}),
  e("paprika", "paprika", ["smoked paprika"], {}),
  e("cumin", "cumin", ["ground cumin", "cumin seed"], {}),
  e("turmeric", "turmeric", ["ground turmeric"], {}),
  e("curry_powder", "curry powder", ["madras powder"], {}),
  e("garam_masala", "garam masala", [], {}),
  e("cinnamon", "cinnamon", ["ground cinnamon"], {}),
  e("bay_leaf", "bay leaf", [], {}),
  e("olive", "olive", ["black olive", "green olive"], {}),
  e("caper", "caper", [], {}),

  // ── Fats, oils, pantry basics ────────────────────────────────────────────
  e("olive_oil", "olive oil", ["extra virgin olive oil"], {}),
  e("oil", "cooking oil", ["vegetable oil", "sunflower oil", "neutral oil", "rapeseed oil"], {}),
  e("sesame_oil", "sesame oil", ["toasted sesame oil"], {}),
  e("salt", "salt", ["sea salt", "table salt", "kosher salt", "flaky salt"], {}),
  e("black_pepper", "black pepper", ["pepper", "white pepper", "cracked black pepper"], {}),
  e("sugar", "sugar", ["white sugar", "caster sugar", "granulated sugar", "brown sugar"], {}),
  e("vinegar", "vinegar", ["white wine vinegar", "red wine vinegar", "rice vinegar", "balsamic vinegar"], {}),
  e("water", "water", ["cold water", "boiling water"], {}),
  e("stock_vegetable", "vegetable stock", ["veg stock", "vegetable broth", "vegetable bouillon"], {}),
  e("wine_red", "red wine", [], {}),
  e("wine_white", "white wine", [], {}),
  e("peanut", "peanut", ["roasted peanut", "peanut butter"], {}),
  e("sesame_seed", "sesame seed", ["toasted sesame seed"], {}),
  e("yeast", "yeast", ["dried yeast", "fast action yeast"], {}),
  e("nut_cashew", "cashew", ["cashew nut"], {}),
  e("nut_almond", "almond", ["flaked almond", "ground almond"], {}),
];

/**
 * Dietary tags expressed as attribute predicates rather than word lists.
 *
 * This is the whole point: "is coconut milk dairy-free?" stops being a string
 * question and becomes `!attrs.dairy`, which is decidable and cannot be fooled
 * by a compound noun.
 */
export const DIETARY_RULES: Record<string, (a: IngredientAttrs) => boolean> = {
  vegetarian: (a) => !a.meat && !a.fish,
  vegan: (a) => !a.meat && !a.fish && !a.dairy && !a.animal,
  "dairy-free": (a) => !a.dairy,
  "gluten-free": (a) => !a.gluten,
  pescatarian: (a) => !a.meat,
};

export const DIETARY_TAGS = Object.keys(DIETARY_RULES);
