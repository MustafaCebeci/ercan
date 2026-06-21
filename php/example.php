<?php
require_once "MesajPaneliApi.php";

try {

	// https://mesajpaneli.com/api sayfasından alınan Api Anahtarınız
	$credentials = new CredentialsHash('API_HASH');


	// Eski Yöntem:
	// Mesajpaneli üzerindeki kullanıcı adı ve şifreniz
	// $credentials = new CredentialsUsernamePassword('kullanıcı_adı', 'şifre' );


	// İleri tarihli mesajlar için UTC başlangıc zamanı, https://www.epochconverter.com/
	// İleri tarihli mesaj gönderilmeyecekse false verilir
	// $ileriTarih = strtotime('2024-01-01 09:00:00');
	$ileriTarih = false;


	// =================================================================
	// Bilgi Sorgulama Örneği
	// =================================================================
	$smsApi             = new MesajPaneliApi($credentials);
	$kullaniciBilgileri = $smsApi->getUser();


	// =================================================================
	// Tekli ve Toplu Mesaj Örneği
	// =================================================================
	$smsApi   = new MesajPaneliApi($credentials);
	$topluSms = new TopluMesaj('MESAJ_METNI', ['5321234567', '5331234567']);
	$smsCevap = $smsApi->topluMesajGonder(
		'BASLIK',         // Sistemde kayıtlı sms başlığı
		$topluSms,        // Tekli ve Toplu mesaj için oluşturulan sms objesi
		true,             // Türkçe karakter kullanımı. false olması durumunda türkçe karakterler replace edilir. Örn: İ->I, ö->o
		$ileriTarih       // İleri tarihli mesajlar için GMT başlangıc zamanı, https://www.epochconverter.com/
	);


	// =================================================================
	// Parametrik Mesaj Örneği ( Her alıcıya farklı mesaj metni )
	// =================================================================
	$smsApi = new MesajPaneliApi($credentials);
	$smsApi->parametrikMesajEkle('5321234567', 'MESAJ_METNI_1');
	$smsApi->parametrikMesajEkle('5331234567', 'MESAJ_METNI_2');
	$smsCevap = $smsApi->parametrikMesajGonder(
		'BASLIK',              // Sistemde kayıtlı sms başlığı
		null,                  // Parametrik sms için null gönderilmelidir
		true,                  // Türkçe karakter kullanımı. false olması durumunda türkçe karakterler replace edilir. Örn: İ->I, ö->o
		$ileriTarih            // İleri tarihli mesajlar için GMT başlangıc zamanı, https://www.epochconverter.com/
	);


} catch (Exception $e) {
	printf("%s: %s", get_class($e), $e->getMessage());
}