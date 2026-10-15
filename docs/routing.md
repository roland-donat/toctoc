# Service d'itinéraire local (OSRM et VROOM)

TOCTOC calcule ses itinéraires à pied sur la machine elle-même. OSRM, profil piéton, fournit les temps de marche sur le réseau OpenStreetMap de la commune ; VROOM choisit et ordonne les portes. Les deux services tournent en conteneurs Docker et n'écoutent que sur `127.0.0.1`. L'application ne leur envoie que des coordonnées, des indices de matrice, des priorités et des durées : jamais une adresse ni un nom.

## Préparation des données

Le dossier de données doit être hors du dépôt, par exemple `~/.local/share/toctoc/routing`. Le script prend le code INSEE de la commune, le même que `TOCTOC_COMMUNE_INSEE`. Ce n'est pas le code postal : pour Clichy-sous-Bois, le code INSEE est 93014 et le code postal 93390.

```bash
deploy/osrm/prepare-commune.sh ~/.local/share/toctoc/routing 93014
```

Le script enchaîne quatre étapes :

1. Il lit le contour de la commune dans l'API publique des communes (`geo.api.gouv.fr`). Seul le code INSEE est envoyé.
2. Il élargit le contour de 3 km, pour que les tournées proches de la limite communale trouvent leurs rues.
3. Il télécharge une seule fois l'extrait OpenStreetMap de la région chez Geofabrik (quelques centaines de Mo ; Île-de-France pour Clichy-sous-Bois).
4. Il découpe la zone, puis prépare le réseau OSRM en profil piéton (MLD). Il faut compter moins d'une minute après le téléchargement.

Si `osmium` n'est pas installé, le script construit une image locale `toctoc-osmium:bookworm` à partir du paquet Debian. Il lui faut aussi `curl`, `node` et Docker.

Pour reprendre une carte à jour : `deploy/osrm/prepare-commune.sh <dossier> <code-insee> --refresh`, puis redémarrer le service `osrm`.

À l'installation sur un serveur, `bin/toctoc-deploy` lance ce script tout seul si aucune donnée routière n'est encore prête.

## Démarrage et arrêt

```bash
export TOCTOC_ROUTING_DATA=~/.local/share/toctoc/routing
docker compose -f deploy/docker-compose.routing.yml up -d     # démarrer
docker compose -f deploy/docker-compose.routing.yml ps        # état
docker compose -f deploy/docker-compose.routing.yml restart osrm   # après une nouvelle préparation
docker compose -f deploy/docker-compose.routing.yml down      # arrêter
```

Les conteneurs redémarrent seuls avec la machine (`restart: unless-stopped`).

Ports par défaut : 5000 pour OSRM, 3010 pour VROOM, ce qui correspond aux valeurs par défaut de `routing.osrm_url` et `routing.vroom_url` dans `config.json`. Si un port est déjà pris, le changer par `TOCTOC_OSRM_PORT` ou `TOCTOC_VROOM_PORT` et reporter la même valeur dans `config.json` :

```json
{ "routing": { "osrm_url": "http://127.0.0.1:5001", "vroom_url": "http://127.0.0.1:3010" } }
```

## Vérification

```bash
# temps de marche entre deux points voisins (en secondes), ici au centre de Clichy-sous-Bois
curl -s "http://127.0.0.1:5000/table/v1/foot/2.5432,48.9081;2.5445,48.9090?annotations=duration"
# VROOM répond
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3010/health
```

Ordre de grandeur attendu : une centaine de secondes pour 100 à 150 m à vol d'oiseau. Si un service est arrêté, l'application ne plante pas : la génération d'itinéraire renvoie l'erreur `routing_unavailable`.
