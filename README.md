# TOCTOC

Application de porte-à-porte militant.

- Carte des portes : chaque adresse de la commune, qualifiée selon le potentiel de mobilisation de ses inscrits, avec le suivi des visites.
- Statistiques : participation par tranche d'âge, bureau de vote et rue, pour savoir où porter l'effort.
- Itinéraires : une zone et une durée choisies, TOCTOC propose une tournée à pied optimisée qui privilégie les portes au plus fort potentiel. Le calcul tourne sur le serveur lui-même.
- Lien terrain : chaque tournée a un lien privé à ouvrir sur téléphone, sans compte. Le militant y saisit ses retours porte par porte, y compris sans réseau. L'écran peut s'installer sur l'écran d'accueil.
- Feuille imprimable : la même tournée sur papier, pour les sorties sans téléphone.
- Suivi : retours datés, corrections, et date de dernier passage à chaque adresse.

Le code est sous licence GNU GPL v3 ou ultérieure (voir `LICENSE`).

## Données personnelles

TOCTOC traite des données personnelles : les noms et adresses de la liste électorale importée par l'organisateur, et les retours de porte-à-porte. Il est conçu pour que ces données restent sous le seul contrôle du groupe qui l'installe.

- Le dépôt ne contient aucune donnée nominative : ni fichier, ni base, ni capture. Les tests n'utilisent que des personnes fictives. Le serveur refuse de démarrer si son dossier de données se trouve dans le dépôt.
- Les données ne vivent que sur le serveur de l'organisateur. Aucun nom ni aucune adresse ne part vers un service tiers. Le calcul d'itinéraire se fait sur le serveur. La seule exception est la localisation des adresses par la Géoplateforme de l'IGN, un service public.
- Toute la préparation (carte, statistiques, itinéraires, suivi) est derrière la connexion de l'administrateur.
- Un lien terrain ne montre que les portes de sa tournée. Il est anonymisé par défaut. Il expire au bout de 7 jours et peut être révoqué à tout moment.
- Le téléphone du militant ne garde que les retours pas encore envoyés, effacés dès leur réception par le serveur, et le lien de la tournée en cours, oublié à son expiration. Aucune réponse du serveur n'y est conservée.
- Les journaux ne contiennent aucune donnée personnelle, et les sauvegardes sont chiffrées pour une clé qui ne quitte pas l'ordinateur de l'administrateur.

Le groupe qui installe un serveur TOCTOC est responsable de ce traitement : il tient le registre des traitements demandé par la CNIL avant la première sortie.

## Prise en main

L'administrateur prépare les tournées depuis un ordinateur ; les militants n'ont besoin que d'un téléphone ou d'une feuille.

1. Connexion : ouvrir l'adresse du serveur et saisir le mot de passe administrateur.
2. Imports : charger les adresses de la commune depuis la Base adresse nationale, puis la liste électorale de la commune si disponible. TOCTOC rattache chaque électeur à une adresse et présente les cas douteux dans une file à trancher à la main.
3. Carte et statistiques : repérer les quartiers et les rues où concentrer l'effort.
4. Itinéraires : dessiner une zone sur la carte, ou choisir un bureau de vote, placer le point de départ, indiquer la durée de la tournée, puis « Calculer ».
5. Sur le terrain : émettre le lien de la tournée et l'envoyer au militant, ou imprimer la feuille. Sur le lien, chaque porte se coche d'un retour : absent, contact obtenu, à revenir, etc.
6. Suivi : les retours arrivent au fur et à mesure. Ceux de la feuille papier se ressaisissent depuis l'écran Suivi de l'itinéraire.

## Créer son serveur

La procédure complète est dans [`docs/deploiement.md`](docs/deploiement.md). En bref :

1. Un serveur Linux allumé en permanence, un nom de domaine qui pointe vers la connexion, et les ports 80 et 443 de la box redirigés vers le serveur.
2. Le code INSEE de la commune, qui n'est pas son code postal : 93014 pour Clichy-sous-Bois (code postal 93390). Un serveur couvre une commune : chaque ville installe le sien. Ce code suffit au calcul d'itinéraire, que l'installation prépare toute seule ([`docs/routing.md`](docs/routing.md)).
3. Sur l'ordinateur de l'administrateur, copier `.env.example` en `.env`, le passer en droits 600 et le remplir : code INSEE de la commune, serveur SSH, domaine, clé publique de sauvegarde créée par `bin/toctoc backup-key`.
4. `bin/toctoc-deploy` installe tout : HTTPS par Caddy et Let's Encrypt, service systemd confiné, cloisonnement réseau, calcul d'itinéraire, sauvegarde quotidienne chiffrée.
5. Définir le mot de passe administrateur, puis lancer `bin/toctoc-check-cyber` pour vérifier l'exposition et le cloisonnement.

## Développement

Vite, React 19, TypeScript strict, TanStack Router et Query, Tailwind v4 et shadcn/ui côté interface ; Hono sur Node, SQLite (Drizzle, better-sqlite3) côté serveur ; Leaflet pour la carte ; Vitest et Playwright pour les tests. Gestionnaire de paquets : pnpm 10.

```bash
pnpm install
cp .env.example .env && chmod 600 .env   # puis TOCTOC_DATA_DIR vers un dossier hors du dépôt
bin/toctoc set-password
pnpm dev                                  # API sur 127.0.0.1:3000, interface sur http://localhost:5173
```

| Commande | Rôle |
|---|---|
| `pnpm typecheck`, `pnpm lint`, `pnpm test` | vérifications |
| `pnpm test:e2e` | parcours Playwright sur données fictives |
| `pnpm db:generate` | migration après modification du schéma (`server/db/schema/`) |
| `bin/toctoc <commande>` | administration : `set-password`, `backup`, `backup-key`, `restore`, `purge` |
