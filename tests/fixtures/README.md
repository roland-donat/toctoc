# Jeux de données de test

Données entièrement fictives : aucun électeur réel. Les adresses de `ban-sample.csv` sont un extrait
public de la Base Adresse Nationale (Séné, rue de Limur et lieu-dit Keravélo, plus deux adresses de
Vannes pour tester le filtrage par commune). Les noms des électeurs reprennent l'alphabet radio.

| Fichier | Format | Cas couverts |
|---|---|---|
| `rep-2026.csv` | liste électorale REP (27 colonnes, `;`, guillemets) | immeuble de 6 inscrits (22 rue de Limur), indice « 13Bis », voie abrégée (« R. de Limur »), voie en minuscules, électeur UE inscrit sur les deux listes complémentaires (numéro d'ordre 1 partagé avec la liste principale), lieu-dit sans numéro, complément « chez … », date de naissance illisible, adresse absente de la BAN (99 rue de Limur) |
| `rep-2027.csv` | liste électorale REP, même format | réimportation (U14) : dérivée de `rep-2026.csv` avec un radié (MIKE, 12 rue de Limur), un déménagé (ALPHA, du 2 au 12 rue de Limur), un nouvel inscrit (WHISKEY, 7 rue de Limur, adresse sans inscrit en 2026) ; l'immeuble du 22 rue de Limur et l'adresse absente de la BAN (VICTOR, 99 rue de Limur) inchangés |
| `emargement-2026.csv` | émargement agrégé (15 colonnes, `;`, CRLF) | votes `oui` / `non` / `??`, électeur sans ligne (QUEBEC), écart de nom (ROMERO pour ROMEO), doublon concordant (TANGO), doublon discordant (BRAVO) |
| `ban-sample.csv` | BAN départementale (23 colonnes) | adresses avec indice `bis`, lieu-dit, autre commune |
