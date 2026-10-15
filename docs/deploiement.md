# Installer son serveur TOCTOC

Procédure de mise en ligne, de redéploiement et de restauration de TOCTOC sur un serveur à soi, par exemple une machine du réseau local derrière une box internet. Un serveur couvre une commune : chaque ville installe le sien. La procédure a été éprouvée sur Arch Linux : le script d'installation utilise `pacman`, à adapter pour une autre distribution.

Il faut :

- un serveur Linux allumé en permanence, avec un compte qui a `sudo`, joignable en SSH depuis l'ordinateur de l'administrateur ;
- un nom de domaine qui pointe vers l'adresse IPv4 publique de la connexion ;
- l'accès à l'administration de la box, pour rediriger les ports 80 et 443 vers le serveur.

## Architecture

| Élément | Emplacement | Exposition |
|---|---|---|
| Application Node (API et interface) | `/opt/toctoc`, service `toctoc` | `127.0.0.1:3000` seulement |
| Caddy (HTTPS, certificat Let's Encrypt) | service `caddy` | ports 80 et 443, redirigés par la box |
| OSRM et VROOM (calcul d'itinéraire) | conteneurs Docker | `127.0.0.1:5000` et `127.0.0.1:3010` seulement |
| Base SQLite et fichiers importés | `/var/lib/toctoc/data` | aucune |
| Sauvegardes chiffrées (age) | `/var/lib/toctoc/backups` | aucune |
| Configuration | `/etc/toctoc/config.json` | aucune |
| Secrets et réglages locaux | `/etc/toctoc/toctoc.env` (droits 640, root et toctoc) | aucune |

Le TLS se termine sur le serveur : aucun intermédiaire ne voit les données en clair. Le calcul d'itinéraire tourne sur le serveur lui-même, donc aucune adresse ne part vers un service tiers. Les sauvegardes sont chiffrées pour une clé publique, et la clé privée reste hors du serveur.

## Prérequis

1. Un nom de domaine, par exemple `toctoc.example.org`, dont l'enregistrement A donne l'adresse IPv4 publique de la connexion. Beaucoup de box fournissent un nom gratuit qui convient. Si ce nom publie aussi une adresse IPv6 (`dig AAAA toctoc.example.org`) qui n'est pas celle du serveur, les navigateurs se rabattent sur l'IPv4 sans que l'utilisateur le voie. À vérifier une fois depuis un téléphone en 4G.
2. Dans l'administration de la box :
   - rediriger TCP 80 et TCP 443 vers l'adresse locale du serveur, et rien d'autre ;
   - sortir de ces deux ports l'éventuel accès distant à l'interface de la box, ou mieux, le désactiver ;
   - ne pas mettre le serveur en DMZ, et désactiver UPnP ou vérifier qu'il n'ouvre aucun port vers le serveur ;
   - donner au serveur une adresse locale fixe (bail DHCP statique).

   Le port 80 ne sert qu'à Let's Encrypt et à rediriger vers HTTPS.
3. Une paire de clés de sauvegarde, créée sur l'ordinateur de l'administrateur, jamais sur le serveur :

   ```bash
   bin/toctoc backup-key ~/Documents/toctoc-sauvegarde.key
   ```

   La commande écrit la clé privée dans le fichier (droits 600) et affiche la clé publique `age1...`. Garder ce fichier en lieu sûr, avec une copie hors de l'ordinateur : sans lui, aucune sauvegarde ne se restaure.
4. Le code INSEE de la commune, qui n'est pas son code postal : 93014 pour Clichy-sous-Bois (code postal 93390). Un serveur TOCTOC couvre une seule commune. L'installation en tire seule les adresses à charger et la zone du calcul d'itinéraire (`docs/routing.md`).

## Réglages : le fichier `.env`

Les réglages propres à une installation ne vont jamais dans le dépôt. Sur l'ordinateur de l'administrateur, copier `.env.example` en `.env` à la racine du dépôt (fichier ignoré par git), le restreindre, puis le remplir :

```bash
cp .env.example .env && chmod 600 .env
```

| Variable | Rôle |
|---|---|
| `TOCTOC_COMMUNE_INSEE` | code INSEE de la commune couverte, par exemple 93014 |
| `TOCTOC_DEPLOY_HOST` | destination SSH du serveur (nom d'hôte ou alias de `~/.ssh/config`) |
| `TOCTOC_DOMAIN` | nom public servi en HTTPS |
| `TOCTOC_BACKUP_RECIPIENT` | clé publique de sauvegarde `age1...` |

TOCTOC refuse un `.env` lisible par d'autres comptes, puisqu'il peut contenir des secrets. Le même mécanisme vaut pour l'application : les variables `TOCTOC_*` de `.env.example` priment sur `config.json`. Sur le serveur, elles se placent dans `/etc/toctoc/toctoc.env`, que l'installation crée vide et ne réécrit jamais.

## Installation et redéploiement

Depuis l'ordinateur de l'administrateur, à la racine du dépôt :

```bash
bin/toctoc-deploy
```

La commande fait un paquet git de la branche `main` et le dépose dans un dossier privé du serveur (`~/toctoc-staging`). Elle lance ensuite `deploy/install-server.sh` sous sudo, puis vérifie que le serveur sert bien ce commit et que le site répond. Le script d'installation enchaîne, dans cet ordre :

1. installer les paquets (Caddy, Docker Compose, pnpm) ;
2. créer le compte `toctoc` et ses dossiers ;
3. mettre en place le cloisonnement réseau, avant toute autre chose ;
4. installer le code et le compiler ;
5. écrire la configuration ;
6. démarrer OSRM et VROOM, puis les services `toctoc`, `toctoc-backup.timer` et `caddy`.

Les migrations de base s'appliquent au démarrage de l'application. La base et le mot de passe administrateur sont conservés d'un déploiement à l'autre.

À la première installation, définir le mot de passe administrateur (16 caractères au moins, demandé deux fois) :

```bash
ssh -t mon-serveur 'sudo -u toctoc env TOCTOC_CONFIG=/etc/toctoc/config.json TOCTOC_ENV_FILE=/etc/toctoc/toctoc.env /opt/toctoc/bin/toctoc set-password'
```

La première installation demande le mot de passe sudo du serveur. Elle pose aussi `/etc/sudoers.d/toctoc`, qui autorise ensuite le compte administrateur à lancer sans mot de passe, et sans argument, deux commandes appartenant à root : `/usr/local/sbin/toctoc-deploy` et `/usr/local/sbin/toctoc-check`. Les déploiements suivants ne demandent donc plus rien. Le domaine, la clé de sauvegarde et la commune sont alors relus dans `/etc/toctoc/deploy.conf` ; pour les changer, `TOCTOC_REINSTALL=1 bin/toctoc-deploy` repasse par le sudo interactif.

Contrepartie de ce confort : qui prend la main sur le compte administrateur du serveur devient root, puisque le déploiement exécute en root le paquet que ce compte dépose. Pour y renoncer, `sudo rm /etc/sudoers.d/toctoc` sur le serveur : chaque déploiement redemandera le mot de passe.

## Sécurité de l'installation

Le serveur est exposé sur Internet depuis le réseau local. L'installation limite ce qu'obtiendrait un attaquant qui prendrait le contrôle de l'application :

- Seuls 80 et 443 sont exposés, vers Caddy. L'application écoute sur `127.0.0.1:3000`, OSRM et VROOM sur `127.0.0.1` seulement.
- L'application tourne sous un compte système dédié, `toctoc`, sans droit d'administration ni accès à Docker. Systemd la confine :
  - système de fichiers en lecture seule, sauf `/var/lib/toctoc` ;
  - pas de répertoires personnels ;
  - aucune capacité système ;
  - aucun autre processus visible ;
  - appels système restreints.
- Cloisonnement réseau sortant (`deploy/system/toctoc-egress.nft`, chargé par `toctoc-egress.service`, dont dépendent l'application et Caddy) :
  - ni l'application ni Caddy n'atteignent le réseau local, préfixe IPv6 public compris, sauf les serveurs DNS de la machine ;
  - sur la machine elle-même, l'application n'atteint qu'OSRM et VROOM, et Caddy que l'application : les autres services du serveur restent hors de portée.
- L'API d'administration de Caddy est désactivée : aucun processus local ne peut réécrire sa configuration.
- Le code installé dans `/opt/toctoc` appartient à root : l'application ne peut pas le modifier. Les dépendances se compilent sous le compte `toctoc`, jamais sous root, et root n'exécute que des fichiers tirés d'une copie propre du paquet git.
- La taille des requêtes est plafonnée par Caddy (25 Mo) et par l'application (64 ko sur la connexion et l'espace terrain). La mémoire du service est plafonnée à 1 Go.
- Connexion :
  - les tentatives sont ralenties par adresse, avec un plafond global sur le compte, si bien qu'un inconnu qui échoue exprès ne bloque que lui ;
  - une session dure 12 h sans activité, et 7 jours au plus.

## Vérifications

```bash
bin/toctoc-check-cyber
```

La commande contrôle d'abord ce que voit Internet :

- le nom et le certificat ;
- la redirection vers HTTPS et les en-têtes de sécurité ;
- le refus des pages d'administration sans connexion ;
- les ports de l'adresse publique : seuls 80 et 443 doivent répondre.

Puis, sur le serveur :

- les services ;
- le cloisonnement de l'application et de Caddy ;
- les droits des fichiers et la règle sudo ;
- une sauvegarde lancée à la main.

Chaque contrôle affiche OK ou FAIL, avec un bilan à la fin. `--local-only` saute la partie serveur.

À faire aussi une fois, à la main :

1. Depuis un téléphone en 4G (Wi-Fi coupé), ouvrir `https://toctoc.example.org` : le certificat est valide et la page de connexion s'affiche.
2. Préparer un itinéraire, émettre son lien, l'ouvrir en 4G et y saisir un retour : il apparaît dans la fiche adresse.
3. Lancer une sauvegarde et la restaurer sur une base vide (section suivante) : les données reviennent.

## Restauration

1. Copier la clé privée sur le serveur le temps de la restauration, dans un fichier lisible par `toctoc` seulement.
2. Arrêter le service, restaurer, redémarrer, puis effacer la clé :

```bash
sudo systemctl stop toctoc
sudo -u toctoc env TOCTOC_CONFIG=/etc/toctoc/config.json TOCTOC_ENV_FILE=/etc/toctoc/toctoc.env /opt/toctoc/bin/toctoc restore \
  /var/lib/toctoc/backups/toctoc-AAAAMMJJ-HHMMSS.db.age --identity /tmp/toctoc-sauvegarde.key --force
sudo systemctl start toctoc
sudo shred -u /tmp/toctoc-sauvegarde.key
```

La commande vérifie que le fichier déchiffré est une base SQLite intègre avant de remplacer quoi que ce soit. Sans `--force`, elle refuse d'écraser une base existante.

## Journaux

`journalctl -u toctoc` : les journaux de l'application ne contiennent aucune donnée personnelle, seulement des événements, des routes et des comptes. Caddy ne tient pas de journal d'accès.

## Fin de campagne

La purge des données nominatives se fait service arrêté :

```bash
sudo systemctl stop toctoc
sudo -u toctoc env TOCTOC_CONFIG=/etc/toctoc/config.json TOCTOC_ENV_FILE=/etc/toctoc/toctoc.env /opt/toctoc/bin/toctoc purge
sudo systemctl start toctoc
```

Elle demande de taper une phrase de confirmation, puis :

- prend une sauvegarde de sécurité chiffrée, détruite automatiquement au bout de 30 jours par la sauvegarde quotidienne ;
- conserve les adresses, les qualifications et un instantané des statistiques ;
- efface tout le reste.

Si elle échoue après l'effacement (message « nominative data is ALREADY DELETED », en général faute de place disque pour le compactage), ne pas supprimer la sauvegarde `toctoc-pre-purge-*.db.age`. Laisser le service arrêté, libérer de la place, puis relancer la purge. La relance garde la sauvegarde de sécurité et l'instantané des statistiques de la première exécution.

## Obligations hors application

Le groupe qui installe un serveur TOCTOC est responsable d'un traitement de données personnelles : il tient le registre des traitements exigé par la CNIL avant la première session de terrain, et informe les personnes comme le prévoit le RGPD.
