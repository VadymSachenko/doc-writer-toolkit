# Український правопис — INDEX

Map from topic → file → § paragraphs. Use this to decide which chunk(s) to load when reviewing a draft. Source: Український правопис (НАН України, 2019).

## How to use this index

Scan the draft for the **load triggers** in each row. If a trigger matches, load the corresponding file. Most drafts will need only 2–5 files. Avoid loading the full ruleset.

For exact word lookup (single word — e.g. "is `на́родний` right?"), grep `99-word-index.md` first to get the § references, then load the matching topical file.

---

## I. Word-stem spelling (правопис основи слова)

| File | §§ | Topic | Load triggers |
|---|---|---|---|
| `01a-vowels-alternations.md` | 1–10 | Vowels (**е/и, і/и, ї, я/ю/є**), apostrophe, **йо/ьо**, alternations **о/і, е/і, о/а, е/о** after ж/ч/ш | Any draft with Ukrainian text (covers the most frequent spelling decisions) |
| `01b-consonants-soft-sign-doubling.md` | 11–31 | Consonant alternations (г/к/х, д/дж, т/ч…), prepositions **у/в**, **з/із/зі**, conjunctions **і/й**, soft sign **ь**, doubled letters | Always — prepositions у/в and conjunctions і/й change by surrounding sounds |
| `01c-suffixes.md` | 32–34 | Noun, adjective, participle, verb suffixes | When forming derived words (e.g. -ник, -ість, -ський, -увати) |
| `01d-compound-words.md` | 35–44 | Compound words: nouns, **прикладка**, numerals, pronouns, adjectives, adverbs, prepositions, conjunctions, particles. Hyphen vs space vs solid spelling | Compound terms, **пів-** words, **не-** prefix, hyphenated nouns (e.g. *учитель-біолог*), складні прикметники (e.g. *українсько-польський*) |
| `01e-capitalization.md` | 45–62 | Capital letters: sentence start, addresses, proper names, geo, historical, religious, government, document titles, **товарні знаки/марки**, abbreviations | Anything with proper names, titles, brands, abbreviations, акроніми. Critical for supplier names, document titles |
| `01f-hyphenation-stress.md` | 63–65 | Word transfer (переноси), stress mark | Rarely needed for digital docs (no line-end hyphenation) |

## II. Endings of inflected words (закінчення відмінюваних слів)

| File | §§ | Topic | Load triggers |
|---|---|---|---|
| `02a-noun-endings.md` | 66–100 | Noun declension by declension class (відміна) and group. All seven cases × singular/plural. Includes відмінювання іменників типу **МБТИ** (acronyms) | Any noun in non-nominative case. Most common: родовий (-а/-у), орудний (-ом/-ою), кличний (Marino → Марино!) |
| `02b-adjective-numeral-pronoun-endings.md` | 101–114 | Adjectives (hard/soft group), comparison degrees, numerals (cardinal/ordinal/fractional), pronouns (personal, reflexive, possessive, demonstrative, interrogative, definite, compound) | Quantities (**два, п’ять, 25**), порядкові числівники, dates, percentages, modal pronouns (цей/той/такий) |
| `02c-verb-forms.md` | 115–120 | Verb conjugation: indicative, imperative, conditional; infinitive; participle (дієприкметник); converb (дієприслівник) | Imperative instructions (**натисніть, виконайте, перевірте**), reflexive verbs (-ся), passive participles (виконано, збережено) |

## III. Foreign words (іншомовного походження)

| File | §§ | Topic | Load triggers |
|---|---|---|---|
| `03-foreign-words.md` | 121–140 | Transliteration of foreign letters/digraphs: **L, G, H, TH, W, LL, J, -TR/-DR, AU, OU, EI, EU**; English [ж], [ə:]; apostrophe and **ь** in foreign words; foreign-noun declension | Any foreign brand, product, technology name. Direct trigger: Latin-script word in the draft (e.g. **UniComPay, Widget, API, UUID, IBAN, JSON, HTTP**) |

## IV. Proper names (власні назви)

| File | §§ | Topic | Load triggers |
|---|---|---|---|
| `04a-personal-names.md` | 141–147 | Ukrainian / Slavic / non-Slavic surnames and given names; declension of names; derived adjectives | Person names in the draft, СМЕ names, author attributions |
| `04b-geographic-names.md` | 148–154 | Geographic names: Ukrainian / foreign; apostrophe and **ь**; declension; derived adjectives; compound geographic names | Place names (warehouses, cities, regions, countries — e.g. **Нью-Йорк, Південна Корея, Брауншвейг**) |

## V. Punctuation (розділові знаки)

| File | §§ | Topic | Load triggers |
|---|---|---|---|
| `05a-period-question-exclaim.md` | 155–157 | Period (.), question mark (?), exclamation mark (!) | Always — covers full-stop rules and abbreviation periods |
| `05b-comma.md` | 158 | Comma — homogeneous members, subordinate clauses, participial/adverbial phrases, addresses, **звертання**, parenthetical words, comparative turns | Always — comma errors are the most common UA punctuation mistake. Especially before **що, який, тому що, якщо, коли, де** |
| `05c-semicolon-colon.md` | 159–160 | Semicolon (;), colon (:) | Lists, generalizing words (**такі як, наприклад, тобто**), explanatory clauses |
| `05d-dash.md` | 161 | Dash (— em-dash) — between subject/predicate, with generalizing words, in incomplete sentences, in dialogues | Procedural intros ending with colon-vs-dash decision, **це — …**, bullet-list intros |
| `05e-ellipsis-brackets.md` | 162–163 | Ellipsis (…), parentheses ( ), [ ], < > | Inline notes, optional fragments, citations |
| `05f-quotes-slash.md` | 164–165 | Quotation marks (« », “ ”, „ “), slash ( / ) | Brand names in quotes (**горілка «Finlandia»**), UI labels in quotes, slash separators |
| `05g-direct-speech-lists.md` | 166–168 | Combined punctuation, direct speech & citations, **правила рубрикації** (list/bullet punctuation: period, semicolon, or comma after items) | Numbered/bulleted lists — critical for procedural docs. Direct quotations from SMEs |

## Lookup index

| File | Purpose | Load triggers |
|---|---|---|
| `99-word-index.md` | Alphabetical lookup of every word treated in the правопис, with § references | Grep this file by word (`Get-Content … \| Select-String "слово"`) when verifying spelling of a specific term. Do **not** read it whole |

---

## Quick decision rules for the reviewer

1. **Always load**: `01a` (vowels), `01b` (prepositions у/в, conjunctions і/й, soft sign), `05a` (period), `05b` (comma), `05g` (list punctuation — critical for procedures)
2. **If draft has numbers/quantities**: add `02b` (numerals)
3. **If draft has imperatives or `-ся` verbs**: add `02c` (verbs)
4. **If draft has Latin-script terms or foreign brands** (UniComPay, Widget, API, UUID, IBAN, JSON, etc.): add `03` and `05f` (quotes)
5. **If draft has proper names (people)**: add `04a`
6. **If draft has place names**: add `04b`
7. **If draft has compound words, **пів-**, **не-**, hyphenated terms**: add `01d`
8. **If draft has abbreviations/acronyms**: add `01e` (§§ 61–62)
9. **If draft has dashes (—)** between subject and predicate or in lists: add `05d`
10. **For specific word doubt**: grep `99-word-index.md` first

## Estimated token budgets

| Loadout | Files | Approx tokens |
|---|---|---|
| Minimum (always-load) | 01a, 01b, 05a, 05b, 05g | ~62k |
| Typical API/partner-doc review | + 02b, 02c, 03, 05f | ~92k |
| With proper names | + 04a or 04b | ~104k |
| Full Part V (punctuation) | all 05* | ~52k |
| Everything except word index | all topical | ~220k |
