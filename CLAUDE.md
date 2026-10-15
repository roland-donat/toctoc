# TOCTOC - Application militante de porte-à-porte

Application militante de porte-à-porte, installée ville par ville (un serveur par commune, réglée par `TOCTOC_COMMUNE_INSEE`) : carte des portes qualifiées (votants, abstentionnistes, adresses sans inscrit), statistiques sur qui vote et qui s'abstient, itinéraires de porte-à-porte optimisés à pied, et suivi daté des visites.

## Notes locales

Le plan de conception et les notes propres à l'installation du mainteneur (serveur, réseau, décisions datées) sont dans `CLAUDE.local.md` et `docs/plans/`, ignorés par git. S'ils existent, les lire avant de travailler : le plan fait autorité sur le périmètre et les décisions.

## Données personnelles : règles impératives

TOCTOC manipule des données nominatives (liste électorale, retours de visite). Ces règles priment sur toute commodité de développement.

- Aucune donnée nominative dans le dépôt git : ni CSV, ni base SQLite, ni capture, ni fixture réelle. Les données vivent dans un dossier hors dépôt désigné par la configuration. Les tests utilisent des données fictives.
- Aucune adresse ni aucun nom ne part vers un service tiers. Le calcul d'itinéraire se fait dans l'application (exigence R14 du plan). La localisation des adresses par la Géoplateforme, service public, est la seule exception admise.
- Toute la préparation (carte, statistiques, fiches, itinéraires, suivi) est derrière la connexion administrateur. Seuls les liens d'itinéraire sont ouverts sans compte, et ils ne montrent que leurs propres portes.
- Côté militant (lien, feuille imprimée) : anonymisé par défaut, jamais de lieu de naissance.
- Aucun tri ni filtre fondé sur la consonance des noms (interdit par la CNIL).
- Les électeurs des listes complémentaires UE ne votent pas à la présidentielle : ils ne sont jamais des cibles.
- Ne jamais afficher de données nominatives réelles dans une sortie de commande, un journal ou une réponse ; travailler sur des comptes et des formats.

## Conventions

- Code en anglais (identifiants, commentaires, messages de commit, messages d'erreur), libellés d'interface en français.
- Types TypeScript stricts, pas de `any`.
- Sauvegarde automatique à chaque action, pas de bouton « Enregistrer ».
- Direction artistique : charte 2027 de la France insoumise (violet, rouge, crème, charbon ; Public Sans et Gowun Batang, auto-hébergées). Couleurs dans `src/index.css`, mascotte et clins d'œil dans `src/components/brand.tsx`. La feuille imprimée reste sobre.
- Artefacts de debug sous `/tmp/`, jamais dans le dépôt. Maquettes dans `docs/mockups/`, gitignoré.

## Stack, commandes et structure

Vite, React 19, TypeScript strict, TanStack Router et Query, Tailwind v4 et shadcn/ui côté interface ; Hono sur Node, SQLite par Drizzle et better-sqlite3 côté serveur ; Leaflet pour la carte ; Vitest et Playwright pour les tests. Gestionnaire de paquets : `pnpm`.

| Commande | Rôle |
|---|---|
| `pnpm dev` | serveur API (port 3000) et Vite (port 5173) en développement |
| `pnpm typecheck`, `pnpm lint`, `pnpm test` | portes de vérification de chaque unité |
| `pnpm test:e2e` | parcours Playwright sur données fictives (dossier `/tmp/toctoc-e2e`) |
| `pnpm db:generate` | migration Drizzle après modification d'un fichier de `server/db/schema/` |
| `bin/toctoc-deploy`, `bin/toctoc-check-cyber` | déploiement sur le serveur et vérifications de sécurité (voir `docs/deploiement.md`) |
| `bin/toctoc <commande>` | administration : `set-password`, `backup`, `backup-key`, `restore`, `purge` |
| `TOCTOC_ROUTING_IT=1 pnpm exec vitest run server/services/route-builder.it.test.ts` | essai d'itinéraire sur OSRM et VROOM réels |

Configuration : `config.json` à la racine (ignoré par git) ou fichier désigné par `TOCTOC_CONFIG`, modèle dans `config.example.json`. `data_dir` et `backup_dir` doivent être hors du dépôt, le serveur refuse de démarrer sinon. Réglages et secrets possibles aussi dans `.env` (variables `TOCTOC_*`, modèle `.env.example`), refusé s'il est lisible par d'autres comptes. En développement : `~/.local/share/toctoc/` (le fichier BAN public y est dans `sources/`).

Structure :

- `server/app.ts` construit l'application Hono à partir d'un `AppContext` (base, configuration, horloge) injecté, ce qui permet aux tests de tourner sur une base en mémoire ; `server/index.ts` la démarre.
- `server/db/schema/` : un fichier par domaine, réexportés par `index.ts` ; migrations versionnées dans `server/db/migrations/`.
- `server/domain/` (règles pures), `server/services/` (imports, routage, purge), `server/routes/` (API).
- `server/lib/log.ts` : journaux sans donnée personnelle (jamais le message d'une erreur, seulement sa classe).
- `src/routes/` : écrans (TanStack Router, fichiers) ; `src/lib/api-client.ts` : accès à l'API.
- `tests/fixtures/` : données fictives uniquement ; `tests/helpers.ts` : contexte de test.
- `deploy/` et `docs/deploiement.md` : mise en ligne sur son serveur, sauvegarde et restauration ; `docs/routing.md` : préparation et exploitation d'OSRM et VROOM.

## Déploiement

Serveur à soi, servi en HTTPS sous un nom de domaine joignable depuis un téléphone. Procédure dans `docs/deploiement.md` ; réglages de l'installation dans `.env` (jamais dans le dépôt, modèle `.env.example`). Aucun détail d'une installation réelle (adresse IP, nom de domaine, nom de machine, réseau local) dans le dépôt, même en exemple : utiliser `example.org` et des noms génériques. Valider tout changement de déploiement sur une instance réelle, pas seulement sur la suite de tests.
