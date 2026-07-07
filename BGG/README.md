# BGG XML API README

## Important Rules

### API Usage Rules
Below are the important usage rules specified by BGG in regards to their [API Usage](https://boardgamegeek.com/using_the_xml_api).

1) When possible, all requests should be made by your servers, with the results cached. Having requests for data or resources come directly from clients (either in the browser or an app) may result in too much traffic, which could be grounds for having your license suspended.
2) You should keep your number of requests to a minimum.
3) Usage limits may be affected by your license.
4) You can monitor your current usage by going to https://boardgamegeek.com/applications and clicking "Usage" under your application name.

### Powered By BGG Images
Since this discord bot is public facing, BGG Legal requires the following:

- As mentioned in the XML API terms of use, public facing apps must include the "Powered by BGG" logo, which should link back to BoardGameGeek. Below is an example of the logo, but you can use any of the files found [here](https://drive.google.com/drive/folders/1k3VgEIpNEY59iTVnpTibt31JcO0rEaSw?usp=drive_link), as long as you display the logo sized so that the text remains easily legible.

https://boardgamegeek.com/image/7779581

## Backup Data
There is a link that is provided to do an export of their DB info as-is. There is a copy of this data in the BGG/backup-data folder in this repo. However, if you need an update, [click here!](https://boardgamegeek.com/data_dumps/bg_ranks)