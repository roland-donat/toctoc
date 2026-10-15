# Service d'itinéraire local (OSRM et VROOM)

TOCTOC calcule ses itinéraires à pied sur la machine elle-même (R14, KTD1). OSRM, profil piéton, fournit les temps de marche sur le réseau OpenStreetMap de Séné ; VROOM choisit et ordonne les portes. Les deux services tournent en conteneurs Docker et n'écoutent que sur `127.0.0.1`. L'application ne leur envoie que des coordonnées, des indices de matrice, des priorités et des durées : jamais une adresse ni un nom.

## Préparation des données

Le dossier de données doit être hors du dépôt, par exemple `~/.local/share/toctoc/routing`.

```bash
deploy/osrm/prepare-sene.sh ~/.local/share/toctoc/routing
```

Le script télécharge l'extrait Bretagne de Geofabrik (environ 330 Mo, une seule fois), découpe la zone de Séné et de ses abords (longitude -2,82 à -2,64, latitude 47,57 à 47,69, ce qui couvre toute la commune avec 2 à 4 km de marge), puis prépare le réseau OSRM en profil piéton (MLD). Il faut compter moins d'une minute après le téléchargement. Si `osmium` n'est pas installé, le script construit une image locale `toctoc-osmium:bookworm` à partir du paquet Debian.

Pour reprendre une carte à jour : `deploy/osrm/prepare-sene.sh <dossier> --refresh`, puis redémarrer le service `osrm`.

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
# temps de marche entre deux points voisins de Séné (en secondes)
curl -s "http://127.0.0.1:5000/table/v1/foot/-2.75,47.62;-2.751,47.621?annotations=duration"
# VROOM répond
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3010/health
```

Ordre de grandeur attendu : une centaine de secondes pour 100 à 150 m à vol d'oiseau. Si un service est arrêté, l'application ne plante pas : la génération d'itinéraire renvoie l'erreur `routing_unavailable`.
