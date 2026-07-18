//! 날씨: open-meteo 지오코딩 → 현재 날씨 + 3일 예보.

use crate::error::AppError;
use crate::http::{client, urlencode};

pub async fn run(location: &str) -> Result<String, AppError> {
    // 1) 지오코딩 (지명 → 위경도)
    let geo_url = format!(
        "https://geocoding-api.open-meteo.com/v1/search?name={}&count=1&language=ko&format=json",
        urlencode(location)
    );
    let geo: serde_json::Value = client().get(&geo_url).send().await?.json().await?;

    let results = geo["results"]
        .as_array()
        .filter(|r| !r.is_empty())
        .ok_or_else(|| AppError::msg(format!("'{location}' 위치를 찾을 수 없습니다.")))?;
    let lat = results[0]["latitude"].as_f64().unwrap_or(0.0);
    let lon = results[0]["longitude"].as_f64().unwrap_or(0.0);
    let place = results[0]["name"].as_str().unwrap_or(location).to_string();

    // 2) 날씨 조회
    let weather_url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,apparent_temperature&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FSeoul&forecast_days=3"
    );
    let weather: serde_json::Value = client().get(&weather_url).send().await?.json().await?;

    let cur = &weather["current"];
    let temp = cur["temperature_2m"].as_f64().unwrap_or(0.0);
    let feels = cur["apparent_temperature"].as_f64().unwrap_or(temp);
    let humidity = cur["relative_humidity_2m"].as_i64().unwrap_or(0);
    let wind = cur["wind_speed_10m"].as_f64().unwrap_or(0.0);
    let code = cur["weather_code"].as_i64().unwrap_or(0);

    let mut out = format!(
        "{} 현재 날씨\n{} | {:.1}°C (체감 {:.1}°C)\n습도 {}% | 바람 {:.1}km/h",
        place,
        code_to_str(code),
        temp,
        feels,
        humidity,
        wind
    );

    let daily = &weather["daily"];
    let max_temps = daily["temperature_2m_max"].as_array();
    let min_temps = daily["temperature_2m_min"].as_array();
    let precip = daily["precipitation_probability_max"].as_array();
    let labels = ["오늘", "내일", "모레"];
    for (i, label) in labels.iter().enumerate() {
        let tmax = max_temps.and_then(|a| a.get(i)).and_then(|v| v.as_f64());
        let tmin = min_temps.and_then(|a| a.get(i)).and_then(|v| v.as_f64());
        let rain = precip.and_then(|a| a.get(i)).and_then(|v| v.as_i64());
        if let (Some(mx), Some(mn)) = (tmax, tmin) {
            let rain_str = rain.map(|r| format!(" 강수 {r}%")).unwrap_or_default();
            out.push_str(&format!("\n{label}: 최고 {mx:.0}°C / 최저 {mn:.0}°C{rain_str}"));
        }
    }
    Ok(out)
}

fn code_to_str(code: i64) -> &'static str {
    match code {
        0 => "맑음 ☀",
        1 => "대체로 맑음 🌤",
        2 => "부분 흐림 ⛅",
        3 => "흐림 ☁",
        45 | 48 => "안개 🌫",
        51 | 53 | 55 => "이슬비 🌦",
        61 | 63 => "비 🌧",
        65 => "강한 비 🌧",
        71 | 73 | 75 => "눈 🌨",
        77 => "눈보라 ❄",
        80 | 81 | 82 => "소나기 🌦",
        85 | 86 => "눈 소나기 🌨",
        95 => "천둥번개 ⛈",
        96 | 99 => "우박 동반 뇌우 ⛈",
        _ => "알 수 없음",
    }
}
